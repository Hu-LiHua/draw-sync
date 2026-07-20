import { contextBridge, ipcRenderer } from 'electron';

// 在 preload 的隔离作用域中缓存最新状态
let _connected = false;
let _messageQueue: any[] = [];

// IPC 监听器在隔离世界运行，收到消息就更新缓存
ipcRenderer.on('connection-status', (_event, connected: boolean) => {
  _connected = connected;
});

ipcRenderer.on('drawing-message', (_event, msg: any) => {
  _messageQueue.push(msg);
});

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (data: ArrayBuffer) => ipcRenderer.invoke('copy-to-clipboard', data),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),

  // 轮询 API：渲染进程定期调用
  getConnectionStatus: () => _connected,
  getDrawingMessages: () => {
    const msgs = [..._messageQueue];
    _messageQueue = [];
    return msgs;
  },
});
