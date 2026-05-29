// Electron main process. Owns the BrowserWindow, spawns the Python sidecar,
// and bridges IPC between the renderer and the sidecar.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let py = null;            // Python child process
let pyBuf = '';           // line-buffer for stdout
let pyStderrTail = '';    // last bit of stderr, used to enrich exit errors
let pyLastError = '';     // last actionable error message we surfaced

// ---------------------------------------------------------------------------
// Python sidecar lifecycle
// ---------------------------------------------------------------------------

function pythonEnginePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python-engine');
  }
  return path.join(__dirname, '..', 'python-engine');
}

// Candidate launchers in order of preference. `py -3` is the Windows launcher
// which is installed by the python.org installer even when `python` isn't on
// PATH (extremely common on fresh Windows installs).
function pythonCandidates() {
  if (process.env.PYTHON) return [[process.env.PYTHON, []]];
  if (process.platform === 'win32') {
    return [['py', ['-3']], ['python', []], ['python3', []]];
  }
  return [['python3', []], ['python', []]];
}

function startPython() {
  if (py) return;
  const enginePath = pythonEnginePath();
  const script = path.join(enginePath, 'ipc_main.py');
  if (!fs.existsSync(script)) {
    sendToRenderer('engine-error', `ipc_main.py not found at ${script}`);
    return;
  }

  // Try each candidate in order; recurse on spawn error.
  const tryNext = (list) => {
    if (!list.length) {
      const tried = pythonCandidates()
        .map(([e, a]) => [e, ...a].join(' ')).join(', ');
      pyLastError =
        `Couldn't find Python. Tried: ${tried}. ` +
        `Install Python 3.10+ from https://python.org (check "Add to PATH"), ` +
        `then restart the app. Or set the PYTHON env var to your python.exe path.`;
      sendToRenderer('engine-error', pyLastError);
      return;
    }
    const [exe, prefixArgs] = list[0];
    const child = spawn(exe, [...prefixArgs, '-u', script], {
      cwd: enginePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    let bound = false;
    child.once('spawn', () => { bound = true; bindPython(child, exe, prefixArgs); });
    child.once('error', (err) => {
      if (bound) return;
      // Try the next candidate.
      tryNext(list.slice(1));
    });
  };
  tryNext(candidates);
}

function bindPython(child, exe, prefixArgs) {
  py = child;
  pyBuf = '';
  pyStderrTail = '';
  pyLastError = '';
  const launchCmd = [exe, ...prefixArgs].join(' ');
  sendToRenderer('engine-event',
    { event: 'log', level: 'info',
      message: `Python sidecar launched via: ${launchCmd}` });

  py.stdout.setEncoding('utf-8');
  py.stdout.on('data', (chunk) => {
    pyBuf += chunk;
    let idx;
    while ((idx = pyBuf.indexOf('\n')) >= 0) {
      const line = pyBuf.slice(0, idx).trim();
      pyBuf = pyBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        sendToRenderer('engine-event', evt);
      } catch (e) {
        sendToRenderer('engine-event',
          { event: 'log', level: 'error',
            message: `bad json from sidecar: ${line.slice(0, 200)}` });
      }
    }
  });

  py.stderr.setEncoding('utf-8');
  py.stderr.on('data', (chunk) => {
    pyStderrTail = (pyStderrTail + chunk).slice(-4000);
    chunk.split(/\r?\n/).filter(Boolean).forEach((line) => {
      sendToRenderer('engine-event',
        { event: 'log', level: 'warn', message: `[py] ${line}` });
    });
  });

  py.on('exit', (code, signal) => {
    const moduleMatch = pyStderrTail.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
    if (moduleMatch) {
      pyLastError =
        `Python is missing the "${moduleMatch[1]}" module. ` +
        `Run this in the app folder:    pip install -r python-engine/requirements.txt    ` +
        `(or double-click install.bat) then restart the app.`;
      sendToRenderer('engine-error', pyLastError);
    } else if (code !== 0) {
      pyLastError =
        `Python sidecar crashed (code=${code} signal=${signal}). ` +
        (pyStderrTail
          ? `Last stderr: ${pyStderrTail.trim().split(/\r?\n/).slice(-3).join(' | ')}`
          : `No stderr captured.`);
      sendToRenderer('engine-error', pyLastError);
    } else {
      sendToRenderer('engine-event',
        { event: 'log', level: 'warn',
          message: `Python sidecar exited cleanly (code=0).` });
    }
    py = null;
  });
}

function sendToPython(msg) {
  if (!py || !py.stdin.writable) {
    // Replay the most recent actionable error if we have one — much more
    // useful than the generic "sidecar is not running".
    sendToRenderer('engine-error',
      pyLastError
        ? `Can't reach Python sidecar. ${pyLastError}`
        : 'Python sidecar is not running. Check the log for startup errors, ' +
          'or run install.bat to set up dependencies.');
    return;
  }
  try {
    py.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    sendToRenderer('engine-error', `Failed to send to sidecar: ${e.message}`);
  }
}

function stopPython() {
  if (!py) return;
  try { sendToPython({ cmd: 'shutdown' }); } catch (_) {}
  setTimeout(() => {
    if (py) { try { py.kill(); } catch (_) {} py = null; }
  }, 300);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// IPC handlers (renderer -> main)
// ---------------------------------------------------------------------------

ipcMain.handle('engine:send', (_evt, msg) => {
  sendToPython(msg);
  return true;
});

ipcMain.handle('dialog:openMidi', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select MIDI file',
    properties: ['openFile'],
    filters: [
      { name: 'MIDI files', extensions: ['mid', 'midi'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('dialog:openMapping', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select mapping JSON',
    defaultPath: path.join(pythonEnginePath(), 'mappings'),
    properties: ['openFile'],
    filters: [
      { name: 'JSON files', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('app:openExternal', (_evt, url) => shell.openExternal(url));

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0e1014',
    title: 'MIDI Player',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // mainWindow.webContents.openDevTools({ mode: 'detach' });  // dev
}

app.whenReady().then(() => {
  createWindow();
  startPython();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPython();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopPython());
