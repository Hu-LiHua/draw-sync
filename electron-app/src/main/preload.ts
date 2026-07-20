import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: () => ipcRenderer.invoke('copy-to-clipboard'),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),
});
