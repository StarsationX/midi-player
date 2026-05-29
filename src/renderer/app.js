// Renderer-side glue: wires DOM controls to the Python sidecar via the
// `window.api` bridge. Owns settings persistence (localStorage), the
// visualizer's render loop, and the log/status views.

const $ = (id) => document.getElementById(id);
const els = {
  midiPath: $('midi-path'),
  midiBrowse: $('midi-browse'),
  targetSelect: $('target-select'),
  targetRefresh: $('target-refresh'),
  mappingSelect: $('mapping-select'),
  mappingBrowse: $('mapping-browse'),
  tempo: $('tempo'),
  tempoLabel: $('tempo-label'),
  countdown: $('countdown'),
  stats: $('stats'),
  hkPlay: $('hotkey-play'),
  hkStop: $('hotkey-stop'),
  hkPause: $('hotkey-pause'),
  hkApply: $('hotkey-apply'),
  hkStatus: $('hotkey-status'),
  play: $('play'),
  pause: $('pause'),
  stop: $('stop'),
  log: $('log'),
  logClear: $('log-clear'),
  pillState: $('pill-state'),
  pillTime: $('pill-time'),
  pillNotes: $('pill-notes'),
  pillBpm: $('pill-bpm'),
  pillFocus: $('pill-focus'),
  progressBar: $('progress-bar'),
  headerMeta: $('header-meta'),
  vizCanvas: $('viz'),
};

const SETTINGS_KEY = 'midi-player.settings.v1';
const settings = Object.assign({
  midiPath: '',
  mapping: 'roblox',
  customMappingPath: '',
  tempo: 1.0,
  countdown: 3,
  stats: false,
  playHotkey: '<f6>',
  stopHotkey: '<f7>',
  pauseHotkey: '<f8>',
  targetHint: '',
}, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let windows = [];
let lastMappingArg = null;        // resolved mapping arg (preset or path)
let lastMidiPath = null;
let totalDuration = 0;
let totalNotes = 0;
let bpm = 0;
let isPlaying = false;
let isPaused = false;
const viz = new Visualizer(els.vizCanvas);

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------
function log(level, message) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  const span = document.createElement('span');
  span.className = `l-${level || 'info'}`;
  const ts = document.createElement('span');
  ts.className = 'l-time';
  ts.textContent = `[${stamp}] `;
  span.appendChild(ts);
  span.appendChild(document.createTextNode(message + '\n'));
  els.log.appendChild(span);
  els.log.scrollTop = els.log.scrollHeight;
}

// --------------------------------------------------------------------------
// Restore UI from settings
// --------------------------------------------------------------------------
function applySettingsToUI() {
  els.midiPath.value = settings.midiPath || '';
  if (settings.customMappingPath && settings.mapping === '__custom__') {
    addCustomMappingOption(settings.customMappingPath);
  }
  els.mappingSelect.value =
    [...els.mappingSelect.options].some(o => o.value === settings.mapping)
      ? settings.mapping : 'roblox';
  els.tempo.value = settings.tempo;
  els.tempoLabel.textContent = `${Number(settings.tempo).toFixed(2)}×`;
  els.countdown.value = settings.countdown;
  els.stats.checked = !!settings.stats;
  els.hkPlay.value = settings.playHotkey;
  els.hkStop.value = settings.stopHotkey;
  els.hkPause.value = settings.pauseHotkey;
}

function addCustomMappingOption(p) {
  const existing = [...els.mappingSelect.options].find(o => o.value === '__custom__');
  if (existing) existing.remove();
  const opt = document.createElement('option');
  opt.value = '__custom__';
  opt.textContent = `custom — ${p.split(/[\\/]/).pop()}`;
  opt.dataset.path = p;
  els.mappingSelect.appendChild(opt);
}

// --------------------------------------------------------------------------
// Engine event handlers
// --------------------------------------------------------------------------
window.api.onEngineError((m) => log('error', m));

window.api.onEngineEvent((evt) => {
  switch (evt.event) {
    case 'ready':
      log('info', 'Engine ready.');
      sendHotkeys();
      requestWindows();
      break;

    case 'log':
      log(evt.level || 'info', evt.message);
      break;

    case 'windows':
      windows = evt.windows;
      populateWindows();
      break;

    case 'midi_loaded':
      // Hand events to the visualizer ahead of playback.
      viz.load(evt.events, evt.note_to_key);
      totalDuration = evt.duration;
      totalNotes = evt.events.length;
      bpm = evt.bpm;
      log('info', `Loaded "${lastMidiPath?.split(/[\\/]/).pop()}" — `
        + `${evt.events.length} events, ${evt.duration.toFixed(1)}s, `
        + `~${evt.bpm.toFixed(1)} BPM`);
      if (evt.unmapped && evt.unmapped.length) {
        log('warn',
          `Skipped ${evt.unmapped.length} notes outside the mapping range: `
          + `[${evt.unmapped.join(', ')}]`);
      }
      updatePills();
      break;

    case 'countdown':
      log('info', `Starting in ${evt.i}…`);
      els.headerMeta.textContent = `Starting in ${evt.i}…`;
      break;

    case 'playback_started':
      isPlaying = true;
      isPaused = false;
      els.play.disabled = true;
      els.pause.disabled = false;
      els.stop.disabled = false;
      setPauseButton(false);
      totalDuration = evt.duration;
      totalNotes = evt.total_notes;
      bpm = evt.bpm;
      viz.startClock(evt.duration);
      els.pillState.textContent = 'Playing';
      els.pillState.style.color = 'var(--good)';
      els.headerMeta.textContent = 'Playing';
      log('info', '=== Playing ===');
      break;

    case 'progress':
      viz.clockSet({
        elapsed: evt.elapsed,
        frozen_elapsed: evt.frozen_elapsed,
      });
      onProgress(evt);
      break;

    case 'playback_done':
      isPlaying = false;
      isPaused = false;
      els.play.disabled = false;
      els.pause.disabled = true;
      els.stop.disabled = true;
      setPauseButton(false);
      viz.stopClock();
      els.pillState.textContent = 'Idle';
      els.pillState.style.color = 'var(--fg)';
      els.headerMeta.textContent = 'Idle';
      log('info', '=== Done ===');
      if (evt.stats) {
        const s = evt.stats;
        log('info',
          `Timing: notes=${s.notes}  mean=${fmtMs(s.mean_ms)}  ` +
          `median=${fmtMs(s.median_ms)}  stdev=${s.stdev_ms.toFixed(2)}ms  ` +
          `max=${fmtMs(s.max_ms)}  >5ms=${s.over_5ms} ` +
          `(${(100*s.over_5ms/s.notes).toFixed(1)}%)`);
      }
      break;

    case 'hotkey':
      if (evt.name === 'play') {
        // Re-purpose Play hotkey as Resume when paused, otherwise start.
        if (isPlaying && isPaused) doResume();
        else doPlay();
      } else if (evt.name === 'stop') doStop();
      else if (evt.name === 'pause') doTogglePause();
      break;

    case 'error':
      log('error', evt.message);
      break;
  }
});

function fmtMs(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + 'ms'; }

function onProgress(evt) {
  const elapsed = viz.elapsed();
  els.pillTime.textContent = `${fmtClock(elapsed)} / ${fmtClock(totalDuration)}`;
  els.pillNotes.textContent = `${evt.played} / ${totalNotes}`;
  els.pillBpm.textContent = `${bpm.toFixed(1)} BPM`;

  // Sync local pause state with engine truth (covers hotkey-driven pauses).
  if (typeof evt.user_paused === 'boolean' && evt.user_paused !== isPaused) {
    isPaused = evt.user_paused;
    setPauseButton(isPaused);
  }

  if (evt.focus_lost) {
    els.pillFocus.textContent = '● LOST FOCUS – paused';
    els.pillFocus.classList.remove('good');
    els.pillFocus.classList.add('bad');
    els.pillState.textContent = isPaused
      ? 'Paused — focus lost'
      : 'Paused — focus lost';
    els.pillState.style.color = 'var(--bad)';
  } else {
    els.pillFocus.textContent = '● FOCUSED';
    els.pillFocus.classList.remove('bad');
    els.pillFocus.classList.add('good');
    if (isPlaying) {
      if (isPaused) {
        els.pillState.textContent = 'Paused';
        els.pillState.style.color = 'var(--warn, #ffc857)';
      } else {
        els.pillState.textContent = 'Playing';
        els.pillState.style.color = 'var(--good)';
      }
    }
  }
}

function setPauseButton(paused) {
  if (paused) {
    els.pause.textContent = '▶ Resume';
    els.pause.classList.add('is-resume');
  } else {
    els.pause.textContent = '⏸ Pause';
    els.pause.classList.remove('is-resume');
  }
}

function fmtClock(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function updatePills() {
  els.pillTime.textContent = `00:00 / ${fmtClock(totalDuration)}`;
  els.pillNotes.textContent = `0 / ${totalNotes}`;
  els.pillBpm.textContent = `${bpm.toFixed(1)} BPM`;
}

// --------------------------------------------------------------------------
// UI actions
// --------------------------------------------------------------------------
els.midiBrowse.addEventListener('click', async () => {
  const p = await window.api.pickMidi();
  if (!p) return;
  els.midiPath.value = p;
  settings.midiPath = p;
  saveSettings();
  loadMidi();
});

els.targetRefresh.addEventListener('click', () => requestWindows());

els.mappingSelect.addEventListener('change', () => {
  if (els.mappingSelect.value === '__custom__') {
    return; // path already set when added
  }
  settings.mapping = els.mappingSelect.value;
  saveSettings();
  loadMidi();
});

els.mappingBrowse.addEventListener('click', async () => {
  const p = await window.api.pickMapping();
  if (!p) return;
  settings.customMappingPath = p;
  settings.mapping = '__custom__';
  addCustomMappingOption(p);
  els.mappingSelect.value = '__custom__';
  saveSettings();
  loadMidi();
});

els.tempo.addEventListener('input', () => {
  settings.tempo = parseFloat(els.tempo.value);
  els.tempoLabel.textContent = `${settings.tempo.toFixed(2)}×`;
  saveSettings();
});
els.tempo.addEventListener('change', () => loadMidi());

els.countdown.addEventListener('change', () => {
  settings.countdown = parseInt(els.countdown.value, 10) || 0;
  saveSettings();
});

els.stats.addEventListener('change', () => {
  settings.stats = els.stats.checked;
  saveSettings();
});

els.hkApply.addEventListener('click', () => {
  settings.playHotkey = els.hkPlay.value.trim() || '<f6>';
  settings.stopHotkey = els.hkStop.value.trim() || '<f7>';
  settings.pauseHotkey = els.hkPause.value.trim() || '<f8>';
  saveSettings();
  sendHotkeys();
});

els.play.addEventListener('click', doPlay);
els.pause.addEventListener('click', doTogglePause);
els.stop.addEventListener('click', doStop);
els.logClear.addEventListener('click', () => { els.log.textContent = ''; });

els.targetSelect.addEventListener('change', () => {
  const idx = parseInt(els.targetSelect.value, 10);
  if (!Number.isNaN(idx) && windows[idx]) {
    settings.targetHint = windows[idx].process || windows[idx].title;
    saveSettings();
  }
});

// --------------------------------------------------------------------------
// Commands -> sidecar
// --------------------------------------------------------------------------
function sendHotkeys() {
  window.api.send({
    cmd: 'set_hotkeys',
    play: settings.playHotkey,
    stop: settings.stopHotkey,
    pause: settings.pauseHotkey,
  });
  els.hkStatus.textContent =
    `Active: Play = ${settings.playHotkey}   `
    + `Stop = ${settings.stopHotkey}   `
    + `Pause = ${settings.pauseHotkey}`;
}

function requestWindows() {
  window.api.send({ cmd: 'list_windows' });
}

function resolveMappingArg() {
  if (els.mappingSelect.value === '__custom__') {
    const opt = [...els.mappingSelect.options].find(o => o.value === '__custom__');
    return opt ? opt.dataset.path : 'roblox';
  }
  return els.mappingSelect.value;
}

function loadMidi() {
  const p = els.midiPath.value;
  if (!p) return;
  lastMidiPath = p;
  lastMappingArg = resolveMappingArg();
  window.api.send({
    cmd: 'load_midi',
    path: p,
    mapping: lastMappingArg,
    tempo: parseFloat(els.tempo.value),
  });
}

function selectedTarget() {
  const idx = parseInt(els.targetSelect.value, 10);
  return Number.isNaN(idx) ? null : windows[idx];
}

function doPlay() {
  if (isPlaying) return;
  const path = els.midiPath.value;
  const target = selectedTarget();
  if (!path) { log('error', 'Pick a MIDI file first.'); return; }
  if (!target) { log('error', 'Pick a target window first (Refresh).'); return; }
  window.api.send({
    cmd: 'play',
    midi_path: path,
    target_hwnd: target.hwnd,
    mapping: resolveMappingArg(),
    tempo: parseFloat(els.tempo.value),
    countdown: parseInt(els.countdown.value, 10) || 0,
    stats: !!els.stats.checked,
  });
}

function doStop() {
  if (!isPlaying) return;
  window.api.send({ cmd: 'stop' });
}

function doPause() {
  if (!isPlaying || isPaused) return;
  isPaused = true;
  setPauseButton(true);
  window.api.send({ cmd: 'pause' });
}

function doResume() {
  if (!isPlaying || !isPaused) return;
  isPaused = false;
  setPauseButton(false);
  window.api.send({ cmd: 'resume' });
}

function doTogglePause() {
  if (!isPlaying) return;
  if (isPaused) doResume();
  else doPause();
}

// --------------------------------------------------------------------------
// Windows dropdown
// --------------------------------------------------------------------------
function populateWindows() {
  els.targetSelect.innerHTML = '';
  if (!windows.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— no windows found —';
    els.targetSelect.appendChild(o);
    return;
  }
  let preselect = -1;
  windows.forEach((w, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    const proc = (w.process || '?').padEnd(28).slice(0, 28);
    o.textContent = `${proc} | ${w.title}`;
    els.targetSelect.appendChild(o);
    if (settings.targetHint &&
        ((w.process || '') + ' ' + (w.title || ''))
        .toLowerCase()
        .includes(settings.targetHint.toLowerCase())) {
      if (preselect === -1) preselect = i;
    }
  });
  if (preselect >= 0) els.targetSelect.value = String(preselect);
}

// --------------------------------------------------------------------------
// Drag-and-drop
// --------------------------------------------------------------------------
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;

function setOverlay(on) {
  dropOverlay.classList.toggle('active', on);
}

window.addEventListener('dragenter', (e) => {
  // Only react to OS-level file drags, not internal text drags.
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  setOverlay(true);
});
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setOverlay(false);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setOverlay(false);
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;

  // Resolve paths via the preload bridge (Electron 32 webUtils).
  const paths = [];
  for (const f of files) {
    try { paths.push(window.api.getDroppedFilePath(f)); }
    catch (_) { /* not a real OS file */ }
  }

  // Prefer the first MIDI; if no MIDI, accept the first JSON as a mapping.
  const midi = paths.find(p => /\.midi?$/i.test(p));
  const json = paths.find(p => /\.json$/i.test(p));

  if (midi) {
    els.midiPath.value = midi;
    settings.midiPath = midi;
    saveSettings();
    log('info', `Dropped MIDI: ${midi.split(/[\\/]/).pop()}`);
    loadMidi();
  } else if (json) {
    settings.customMappingPath = json;
    settings.mapping = '__custom__';
    addCustomMappingOption(json);
    els.mappingSelect.value = '__custom__';
    saveSettings();
    log('info', `Dropped mapping: ${json.split(/[\\/]/).pop()}`);
    loadMidi();
  } else {
    log('warn', `Drop ignored — only .mid/.midi/.json files are supported.`);
  }
});

// Prevent accidental file navigation if drop misses our handler.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

// --------------------------------------------------------------------------
// Render loop
// --------------------------------------------------------------------------
function frame() {
  viz.render();
  if (totalDuration > 0) {
    const pct = Math.min(100, 100 * viz.elapsed() / totalDuration);
    els.progressBar.style.width = pct + '%';
  }
  // Tween the time pill between progress packets too.
  if (isPlaying) {
    els.pillTime.textContent =
      `${fmtClock(viz.elapsed())} / ${fmtClock(totalDuration)}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
applySettingsToUI();
log('info', 'Booting…');
