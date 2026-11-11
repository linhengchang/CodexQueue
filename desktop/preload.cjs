const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('autoWork', { chooseProject: () => ipcRenderer.invoke('choose-project'), openWorktree: (batchId, taskId) => ipcRenderer.invoke('open-worktree', batchId, taskId), openStorage: category => ipcRenderer.invoke('open-storage', category) });
