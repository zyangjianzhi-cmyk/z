import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { createStudio } from '../server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.env.LUMINA_USER_DATA) app.setPath('userData', process.env.LUMINA_USER_DATA);
let window;
let studio;
let closing = false;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      if (process.platform === 'win32') {
        const bundled = app.isPackaged ? path.join(process.resourcesPath, 'dreamina.exe') : path.join(here, '..', 'vendor', 'dreamina.exe');
        await access(bundled);
        process.env.DREAMINA_BIN = bundled;
      }
      studio = await createStudio({ dataDir: path.join(app.getPath('userData'), 'projects') });
      await new Promise((resolve, reject) => {
        studio.server.once('error', reject);
        studio.server.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${studio.server.address().port}`;
      Menu.setApplicationMenu(null);
      window = new BrowserWindow({
        title: 'Lumina · 灵感工作室', width: 1400, height: 960, minWidth: 900, minHeight: 680,
        show: false, backgroundColor: '#f8f9fc', titleBarStyle: 'hidden',
        icon: path.join(here, 'assets', 'icon.png'),
        webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged },
      });
      window.once('ready-to-show', () => window.show());
      // No arbitrary shell commands, file access or Node APIs are exposed to the renderer.
      function trusted(event) { return event.senderFrame?.url.startsWith(origin + '/') && event.sender === window?.webContents; }
      ipcMain.on('window:action', (event, action) => {
        if (!trusted(event)) return;
        if (action === 'minimize') window.minimize();
        if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
        if (action === 'close') window.close();
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const target = new URL(url);
          if (target.protocol === 'https:') shell.openExternal(target.href).catch(console.error);
        } catch {}
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(origin + '/')) event.preventDefault();
      });
      await window.loadURL(origin);
    } catch (error) {
      dialog.showErrorBox('Lumina 启动失败', `请重试或将此信息反馈给开发者。\n\n${error.message}`);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (studio && !closing) {
      event.preventDefault(); closing = true;
      window?.destroy();
      studio.server.closeAllConnections();
      studio.close().finally(() => app.quit());
    }
  });
}
