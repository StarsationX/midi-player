// Electron main process. Owns the BrowserWindow, spawns the Python sidecar,
// and bridges IPC between the renderer and the sidecar.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let py = null;            // Python child process
let pyBuf = '';           // line-buffer for stdout

// ---------------------------------------------------------------------------
// Python sidecar lifecycle
// ---------------------------------------------------------------------------

function pythonEnginePath() {
  // In dev: python-engine/ next to package.json. In production (packaged):
  // process.resourcesPath/python-engine.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python-engine');
  }
  return path.join(__dirname, '..', 'python-engine');
}

function pythonExecutable() {
  // Honour PYTHON env var if set, else use 'python' on PATH.
  return process.env.PYTHON || 'python';
}

function startPython() {
  if (py) return;
  const enginePath = pythonEnginePath();
  const script = path.join(enginePath, 'ipc_main.py');
  if (!fs.existsSync(script)) {
    sendToRenderer('engine-error', `ipc_main.py not found at ${script}`);
    return;
  }
  py = spawn(pythonExecutable(), ['-u', script], {
    cwd: enginePath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });

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
    // Python tracebacks etc. — surface as logs, not errors (Python warnings
    // come here too).
    chunk.split(/\r?\n/).filter(Boolean).forEach((line) => {
      sendToRenderer('engine-event',
        { event: 'log', level: 'warn', message: `[py] ${line}` });
    });
  });

  py.on('exit', (code, signal) => {
    sendToRenderer('engine-event',
      { event: 'log', level: 'warn',
        message: `Python sidecar exited (code=${code} signal=${signal})` });
    py = null;
  });

  py.on('error', (err) => {
    sendToRenderer('engine-error',
      `Failed to spawn Python: ${err.message}. ` +
      `Set PYTHON env var to your python.exe or install Python 3.9+.`);
    py = null;
  });
}

function sendToPython(msg) {
  if (!py || !py.stdin.writable) {
    sendToRenderer('engine-error', 'Python sidecar is not running.');
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
