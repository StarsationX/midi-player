// Bridge: exposes a small, typed API to the renderer.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // send a JSON command to the Python sidecar
  send: (msg) => ipcRenderer.invoke('engine:send', msg),

  // event stream from the Python sidecar (and from main on engine errors)
  onEngineEvent: (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on('engine-event', fn);
    return () => ipcRenderer.off('engine-event', fn);
  },
  onEngineError: (handler) => {
    const fn = (_e, msg) => handler(msg);
    ipcRenderer.on('engine-error', fn);
    return () => ipcRenderer.off('engine-error', fn);
  },

  // file pickers
  pickMidi: () => ipcRenderer.invoke('dialog:openMidi'),
  pickMapping: () => ipcRenderer.invoke('dialog:openMapping'),

  // dropped-file path resolution. Electron 32 removed the file.path
  // property — webUtils.getPathForFile is the supported replacement.
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // updater
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: (opts) => ipcRenderer.invoke('update:check', opts),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdateStatus: (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on('update-status', fn);
    return () => ipcRenderer.off('update-status', fn);
  },
});
