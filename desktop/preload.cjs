const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('autoWork', { chooseProject: () => ipcRenderer.invoke('choose-project'), openStorage: category => ipcRenderer.invoke('open-storage', category) });
