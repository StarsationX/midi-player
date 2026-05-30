// Self-updater for the portable build.
//
// electron-updater doesn't support the portable .exe target, so we roll a
// small one: poll the GitHub Releases API, compare versions, download the
// new portable .exe, then hand off to a tiny batch script that waits for
// this process to exit, swaps the old .exe for the new one, and relaunches.
//
// The original .exe the user double-clicked is exposed by electron-builder's
// portable target as process.env.PORTABLE_EXECUTABLE_FILE. The running
// Electron actually executes from a %TEMP% extraction, so overwriting that
// original file while we're alive is safe — the batch just retries the copy
// until the lock (if any) clears.

const { app, shell } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO = 'StarsationX/midi-player';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// ---- version compare ------------------------------------------------------

function parseVer(v) {
  return String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
}
// returns >0 if a>b, <0 if a<b, 0 if equal
function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---- HTTPS helpers (manual redirect follow) -------------------------------

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'midi-player-updater', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGetJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub API HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad JSON from GitHub API')); }
      });
    }).on('error', reject);
  });
}

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'midi-player-updater' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, destPath, onProgress));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total && onProgress) onProgress(got / total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

// ---- public API -----------------------------------------------------------

let cachedAsset = null;   // { version, url, name, size, notes, htmlUrl }

async function checkForUpdates(send, { manual } = {}) {
  try {
    if (manual) send({ state: 'checking' });
    const rel = await httpsGetJson(LATEST_API);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    const asset = (rel.assets || []).find(a => /\.exe$/i.test(a.name));

    if (cmpVer(latest, current) > 0 && asset) {
      cachedAsset = {
        version: latest.replace(/^v/i, ''),
        url: asset.browser_download_url,
        name: asset.name,
        size: asset.size,
        notes: rel.body || '',
        htmlUrl: rel.html_url,
      };
      send({
        state: 'available',
        version: cachedAsset.version,
        current,
        size: cachedAsset.size,
        notes: cachedAsset.notes.slice(0, 2000),
        canSelfUpdate: !!process.env.PORTABLE_EXECUTABLE_FILE,
        htmlUrl: cachedAsset.htmlUrl,
      });
    } else {
      cachedAsset = null;
      if (manual) send({ state: 'none', current });
    }
  } catch (e) {
    if (manual) send({ state: 'error', message: String(e.message || e) });
  }
}

async function applyUpdate(send) {
  if (!cachedAsset) { send({ state: 'error', message: 'No update staged.' }); return; }

  const target = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!target) {
    // Not a portable build (dev / NSIS) — just open the release page.
    shell.openExternal(cachedAsset.htmlUrl);
    return;
  }

  try {
    send({ state: 'downloading', percent: 0 });
    const newExe = path.join(path.dirname(target), `.midi-player-update-${cachedAsset.version}.exe`);
    await download(cachedAsset.url, newExe, (p) => {
      send({ state: 'downloading', percent: Math.round(p * 100) });
    });

    send({ state: 'ready' });

    // Batch: wait for this exe to be replaceable (copy fails while locked),
    // swap it, relaunch, clean up the temp copy and itself.
    const bat = path.join(os.tmpdir(), `midi-player-update-${Date.now()}.bat`);
    const script =
      '@echo off\r\n' +
      'ping 127.0.0.1 -n 2 >nul\r\n' +
      ':loop\r\n' +
      `copy /y "${newExe}" "${target}" >nul 2>nul\r\n` +
      'if errorlevel 1 (\r\n' +
      '  ping 127.0.0.1 -n 2 >nul\r\n' +
      '  goto loop\r\n' +
      ')\r\n' +
      `del "${newExe}" >nul 2>nul\r\n` +
      `start "" "${target}"\r\n` +
      '(goto) 2>nul & del "%~f0"\r\n';
    fs.writeFileSync(bat, script, 'utf8');

    const child = spawn('cmd.exe', ['/c', bat], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    // Give the batch a beat to start, then quit so the swap can happen.
    setTimeout(() => app.quit(), 400);
  } catch (e) {
    send({ state: 'error', message: String(e.message || e) });
  }
}

module.exports = { checkForUpdates, applyUpdate, cmpVer };
