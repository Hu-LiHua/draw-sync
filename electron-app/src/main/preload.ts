import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (data: ArrayBuffer) => ipcRenderer.invoke('copy-to-clipboard', data),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),

  /** PC 端操作（翻页等）→ 回发 WebSocket 消息给 Android */
  sendToClient: (msg: any) => ipcRenderer.send('send-to-client', msg),

  onDrawingMessage: (callback: (msg: any) => void) => {
    ipcRenderer.on('drawing-message', (_event, msg) => callback(msg));
  },
  onConnectionStatus: (callback: (connected: boolean) => void) => {
    ipcRenderer.on('connection-status', (_event, connected) => callback(connected));
  },
});
