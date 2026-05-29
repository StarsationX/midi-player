// Renderer-side glue: wires DOM controls to the Python sidecar via the
// `window.api` bridge. Owns settings persistence, the visualizer's render
// loop, scrubber UX, log routing.

const $ = (id) => document.getElementById(id);
const els = {
  // sidebar — source
  midiPath: $('midi-path'),
  midiBrowse: $('midi-browse'),
  targetSelect: $('target-select'),
  targetRefresh: $('target-refresh'),
  mappingSelect: $('mapping-select'),
  mappingBrowse: $('mapping-browse'),
  // sidebar — playback
  tempo: $('tempo'),
  tempoLabel: $('tempo-label'),
  countdown: $('countdown'),
  stats: $('stats'),
  // sidebar — hotkeys
  hkPlay: $('hotkey-play'),
  hkStop: $('hotkey-stop'),
  hkPause: $('hotkey-pause'),
  hkApply: $('hotkey-apply'),
  hkStatus: $('hotkey-status'),
  // header
  headerStatus: $('header-status'),
  statusText: $('status-text'),
  // transport
  play: $('play'),
  pause: $('pause'),
  stop: $('stop'),
  timeElapsed: $('time-elapsed'),
  timeTotal: $('time-total'),
  metaNotes: $('meta-notes'),
  metaBpm: $('meta-bpm'),
  // scrubber
  scrubber: $('scrubber'),
  scrubFill: $('scrubber-fill'),
  scrubHover: $('scrubber-hover'),
  scrubThumb: $('scrubber-thumb'),
  scrubTooltip: $('scrubber-tooltip'),
  // viz / log
  vizCanvas: $('viz'),
  vizEmptyHint: $('viz-empty-hint'),
  logPanel: $('log-panel'),
  log: $('log'),
  logClear: $('log-clear'),
  logToggle: $('log-toggle'),
};

const SETTINGS_KEY = 'midi-player.settings.v2';
const settings = Object.assign({
  midiPath: '',
  mapping: 'roblox',
  customMappingPath: '',
  tempo: 1.0,
  countdown: 0,
  stats: false,
  playHotkey: '<f6>',
  stopHotkey: '<f7>',
  pauseHotkey: '<f8>',
  targetHint: '',
  logCollapsed: false,
}, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let windows = [];
let lastMidiPath = null;
let totalDuration = 0;
let totalNotes = 0;
let bpm = 0;
let isPlaying = false;
let isPaused = false;
let isFocusLost = false;
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
// Settings -> UI
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
  if (settings.logCollapsed) {
    els.logPanel.classList.add('is-collapsed');
    els.logToggle.textContent = 'Expand';
  }
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
      viz.load(evt.events, evt.note_to_key);
      totalDuration = evt.duration;
      totalNotes = evt.events.length;
      bpm = evt.bpm;
      els.vizEmptyHint.classList.add('is-hidden');
      log('info', `Loaded "${lastMidiPath?.split(/[\\/]/).pop()}" — `
        + `${evt.events.length} events, ${evt.duration.toFixed(1)}s, `
        + `~${evt.bpm.toFixed(1)} BPM`);
      if (evt.unmapped && evt.unmapped.length) {
        log('warn',
          `Skipped ${evt.unmapped.length} notes outside the mapping range: `
          + `[${evt.unmapped.join(', ')}]`);
      }
      refreshTransport();
      break;

    case 'countdown':
      // Only surfaced when countdown > 0 — engine skips entirely when 0.
      log('info', `Starting in ${evt.i}…`);
      setStatus('paused', `Starting in ${evt.i}…`);
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
      setStatus('playing', 'Playing');
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
      setStatus('idle', 'Idle');
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
  // Sync local pause state with engine truth.
  if (typeof evt.user_paused === 'boolean' && evt.user_paused !== isPaused) {
    isPaused = evt.user_paused;
    setPauseButton(isPaused);
  }
  isFocusLost = !!evt.focus_lost;

  // Determine label
  if (!isPlaying) {
    setStatus('idle', 'Idle');
  } else if (isFocusLost) {
    setStatus('blocked', 'Paused · focus lost');
  } else if (isPaused) {
    setStatus('paused', 'Paused');
  } else {
    setStatus('playing', 'Playing');
  }

  els.metaNotes.textContent = `${evt.played} / ${totalNotes}`;
}

function setStatus(kind, text) {
  els.headerStatus.classList.remove('is-playing', 'is-paused', 'is-blocked');
  if (kind === 'playing') els.headerStatus.classList.add('is-playing');
  else if (kind === 'paused') els.headerStatus.classList.add('is-paused');
  else if (kind === 'blocked') els.headerStatus.classList.add('is-blocked');
  els.statusText.textContent = text;
}

function setPauseButton(paused) {
  if (paused) {
    els.pause.querySelector('span').textContent = 'Resume';
    els.pause.classList.add('is-resume');
    els.pause.title = 'Resume (F8)';
  } else {
    els.pause.querySelector('span').textContent = 'Pause';
    els.pause.classList.remove('is-resume');
    els.pause.title = 'Pause (F8)';
  }
}

function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function refreshTransport() {
  els.timeTotal.textContent = fmtClock(totalDuration);
  els.timeElapsed.textContent = fmtClock(viz.elapsed());
  els.metaNotes.textContent = `0 / ${totalNotes}`;
  els.metaBpm.textContent = bpm ? `${bpm.toFixed(1)} BPM` : '— BPM';
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
  if (els.mappingSelect.value === '__custom__') return;
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
els.logToggle.addEventListener('click', () => {
  els.logPanel.classList.toggle('is-collapsed');
  settings.logCollapsed = els.logPanel.classList.contains('is-collapsed');
  els.logToggle.textContent = settings.logCollapsed ? 'Expand' : 'Collapse';
  saveSettings();
});

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
    `Play ${settings.playHotkey}   ·   Pause ${settings.pauseHotkey}   ·   Stop ${settings.stopHotkey}`;
}

function requestWindows() { window.api.send({ cmd: 'list_windows' }); }

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
  window.api.send({
    cmd: 'load_midi',
    path: p,
    mapping: resolveMappingArg(),
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
  setStatus('paused', 'Paused');
  window.api.send({ cmd: 'pause' });
}

function doResume() {
  if (!isPlaying || !isPaused) return;
  isPaused = false;
  setPauseButton(false);
  setStatus('playing', 'Playing');
  window.api.send({ cmd: 'resume' });
}

function doTogglePause() {
  if (!isPlaying) return;
  if (isPaused) doResume();
  else doPause();
}

// Throttled seek — at most ~30 Hz so a rapid drag doesn't flood the sidecar.
let pendingSeek = null;
let lastSeekSentAt = 0;
function requestSeek(t) {
  pendingSeek = t;
  const now = performance.now();
  if (now - lastSeekSentAt >= 33) flushSeek();
  else if (!flushSeek._scheduled) {
    flushSeek._scheduled = true;
    setTimeout(() => { flushSeek._scheduled = false; flushSeek(); }, 33);
  }
}
function flushSeek() {
  if (pendingSeek === null) return;
  const t = pendingSeek; pendingSeek = null;
  lastSeekSentAt = performance.now();
  window.api.send({ cmd: 'seek', time: t });
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
// Scrubber — YouTube-style: hover preview, click-to-seek, drag-to-scrub
// --------------------------------------------------------------------------
let isDragging = false;

function scrubberRect() { return els.scrubber.getBoundingClientRect(); }

function clientXToTime(clientX) {
  if (totalDuration <= 0) return 0;
  const r = scrubberRect();
  const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  return pct * totalDuration;
}

function updateHoverIndicator(clientX, isOverBar) {
  if (totalDuration <= 0) {
    els.scrubHover.style.width = '0%';
    return;
  }
  const r = scrubberRect();
  const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  if (isOverBar) els.scrubHover.style.width = `${pct * 100}%`;
  // Tooltip
  const t = pct * totalDuration;
  els.scrubTooltip.textContent = fmtClock(t);
  // position tooltip — center on cursor, clamped to track
  const trackWidth = r.width;
  const tooltipX = Math.max(20, Math.min(trackWidth - 20, clientX - r.left));
  els.scrubTooltip.style.left = `${tooltipX}px`;
}

els.scrubber.addEventListener('mousemove', (e) => {
  if (isDragging) return;          // handled by window listener below
  updateHoverIndicator(e.clientX, true);
});
els.scrubber.addEventListener('mouseleave', () => {
  if (!isDragging) els.scrubHover.style.width = '0%';
});

els.scrubber.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (totalDuration <= 0) return;
  isDragging = true;
  els.scrubber.classList.add('is-dragging');
  const t = clientXToTime(e.clientX);
  viz.seek(t);
  requestSeek(t);
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  updateHoverIndicator(e.clientX, false);
  const t = clientXToTime(e.clientX);
  viz.seek(t);
  requestSeek(t);
});

window.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  els.scrubber.classList.remove('is-dragging');
  // ensure the last position is sent (bypass throttle)
  if (pendingSeek !== null) flushSeek();
});

// Keyboard scrubbing on the slider (Left/Right arrows, Home/End)
els.scrubber.addEventListener('keydown', (e) => {
  if (totalDuration <= 0) return;
  let cur = viz.elapsed();
  let next = cur;
  if (e.key === 'ArrowLeft')  next = cur - 5;
  else if (e.key === 'ArrowRight') next = cur + 5;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End')  next = totalDuration;
  else return;
  e.preventDefault();
  next = Math.max(0, Math.min(totalDuration, next));
  viz.seek(next);
  requestSeek(next);
});

// --------------------------------------------------------------------------
// Drag-and-drop
// --------------------------------------------------------------------------
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;
function setOverlay(on) { dropOverlay.classList.toggle('active', on); }

window.addEventListener('dragenter', (e) => {
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
  const paths = [];
  for (const f of files) {
    try { paths.push(window.api.getDroppedFilePath(f)); } catch (_) {}
  }
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
// catch-all so a missed drop doesn't navigate the page away
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

// --------------------------------------------------------------------------
// Render loop
// --------------------------------------------------------------------------
function frame() {
  viz.render();
  const elapsed = viz.elapsed();

  // Scrubber fill + thumb
  if (totalDuration > 0) {
    const pct = Math.max(0, Math.min(100, 100 * elapsed / totalDuration));
    els.scrubFill.style.width = pct + '%';
    els.scrubThumb.style.left = pct + '%';
    els.scrubber.setAttribute('aria-valuenow', pct.toFixed(0));
  } else {
    els.scrubFill.style.width = '0%';
    els.scrubThumb.style.left = '0%';
  }

  // Time display
  els.timeElapsed.textContent = fmtClock(elapsed);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
applySettingsToUI();
refreshTransport();
log('info', 'Booting…');
