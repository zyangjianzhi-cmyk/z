const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('luminaDesktop', Object.freeze({
  platform: process.platform,
  openAuthorization(url) { return ipcRenderer.invoke('auth:open', url); },
  windowAction(action) {
    if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('window:action', action);
  },
}));
