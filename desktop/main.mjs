import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir, access } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { runtimeDataRoot, migrateRuntimeData, developmentToolPath } from './runtime-data.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../dist/server/index.js';
import { worktreeDirectory } from '../dist/server/worktree-directory.js';

app.setName('Auto Work');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = runtimeDataRoot({ packaged: app.isPackaged, resourceRoot: root, appData: app.getPath('appData'), override: process.env.AUTO_WORK_DATA_ROOT });
if (app.isPackaged || process.env.AUTO_WORK_DATA_ROOT) { mkdirSync(dataRoot, { recursive: true }); app.setPath('userData', dataRoot); }
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
      process.env.PATH = await developmentToolPath(process.env.PATH, app.getPath('home'));
      if (app.isPackaged && !process.env.AUTO_WORK_SMOKE_CLOSE_MS) {
        let exists = true; try { await access(path.join(dataRoot, 'data/state.json')); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
        if (!exists) {
          const choice = await dialog.showMessageBox({ type: 'question', title: 'Auto Work', message: '是否导入旧版数据？', detail: '请先关闭旧版程序。选择旧项目目录会复制 data、task、todo；原文件和业务代码保留，定时运行需重新启用。', buttons: ['全新开始', '选择旧项目目录'], defaultId: 0, cancelId: 0 });
          if (choice.response === 1) {
            const selected = await dialog.showOpenDialog({ title: '选择旧项目目录', properties: ['openDirectory'] });
            if (selected.canceled) { await shutdown(); return; }
            await migrateRuntimeData(selected.filePaths[0], dataRoot);
          }
        }
      }
      instance = await startServer({ resourceRoot: root, dataRoot, port: 0, trash: file => shell.trashItem(file) });
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
      ipcMain.handle('open-worktree', async (event, batchId, taskId) => {
        if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== instance.origin) throw new Error('面板会话无效');
        const directory = await worktreeDirectory(instance.store, batchId, taskId);
        const error = await shell.openPath(directory); if (error) throw new Error(error);
        return directory;
      });
      ipcMain.handle('open-storage', async (event, category) => {
        if (event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== instance.origin) return;
        const directories = { root: '.', attachments: 'data/attachments', task: 'task', todo: 'todo', recycle: 'data/recycle-bin', worktrees: 'data/worktree-records' };
        if (!(category in directories)) throw new Error('目录不存在');
        const directory = path.join(instance.store.root, directories[category]); await mkdir(directory, { recursive: true });
        const error = await shell.openPath(directory); if (error) throw new Error(error);
      });
      await window.loadURL(instance.origin);
      if (process.env.AUTO_WORK_SMOKE_CLOSE_MS) setTimeout(() => void shutdown(), Number(process.env.AUTO_WORK_SMOKE_CLOSE_MS));
      console.log(`AUTO_WORK_READY ${instance.origin}`);
    } catch (e) { dialog.showErrorBox('Auto Work 启动失败', String(e)); await shutdown(); }
  });
}
