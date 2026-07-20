import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (data: ArrayBuffer) => ipcRenderer.invoke('copy-to-clipboard', data),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),

  // WebSocket 消息和连接状态监听
  onDrawingMessage: (callback: (msg: any) => void) => {
    ipcRenderer.on('drawing-message', (_event, msg) => callback(msg));
  },
  onConnectionStatus: (callback: (connected: boolean) => void) => {
    ipcRenderer.on('connection-status', (_event, connected) => callback(connected));
  },
});
