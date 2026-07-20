import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (data: ArrayBuffer) => ipcRenderer.invoke('copy-to-clipboard', data),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),

  // 标准回调模式：渲染进程注册回调，preload 监听 IPC
  onDrawingMessage: (callback: (msg: any) => void) => {
    ipcRenderer.on('drawing-message', (_event, msg) => callback(msg));
  },
  onConnectionStatus: (callback: (connected: boolean) => void) => {
    ipcRenderer.on('connection-status', (_event, connected) => callback(connected));
  },
});
