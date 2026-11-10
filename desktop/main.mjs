import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../dist/server/index.js';

app.setName('Auto Work');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let instance; let window; let stopping = false; let stopped = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  window?.setTitle('Auto Work · 正在停止任务与服务…');
  try { await instance?.close(); } catch (e) { console.error(e); }
  stopped = true; app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('before-quit', e => { if (!stopped) { e.preventDefault(); void shutdown(); } });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void shutdown());
  app.whenReady().then(async () => {
    try {
      instance = await startServer({ root, port: 0, trash: file => shell.trashItem(file) });
      window = new BrowserWindow({ width: 1400, height: 950, minWidth: 850, minHeight: 650, title: 'Auto Work', backgroundColor: '#f7f8fa', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(root, 'desktop/preload.cjs') } });
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== instance.origin) event.preventDefault(); });
      window.on('close', event => { if (!stopped) { event.preventDefault(); void shutdown(); } });
      ipcMain.handle('choose-project', async event => {
        if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== instance.origin) return null;
        const result = await dialog.showOpenDialog(window, { title: '选择目标项目', properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
      });
      ipcMain.handle('open-storage', async (event, category) => {
        if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== instance.origin) return;
        const directories = { attachments: 'data/attachments', task: 'task', todo: 'todo', recycle: 'data/recycle-bin', worktrees: 'data/worktree-records' };
        if (!(category in directories)) throw new Error('目录不存在');
        const directory = path.join(root, directories[category]); await mkdir(directory, { recursive: true });
        const error = await shell.openPath(directory); if (error) throw new Error(error);
      });
      await window.loadURL(instance.origin);
      if (process.env.AUTO_WORK_SMOKE_CLOSE_MS) setTimeout(() => void shutdown(), Number(process.env.AUTO_WORK_SMOKE_CLOSE_MS));
      console.log(`AUTO_WORK_READY ${instance.origin}`);
    } catch (e) { dialog.showErrorBox('Auto Work 启动失败', String(e)); await shutdown(); }
  });
}
