import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { registerIpcHandlers } from './ipc-handlers';
import { DrawSyncServer } from './WebSocketServer';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DrawSync',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 获取本机局域网 IP 并发送到渲染进程
  mainWindow.webContents.on('did-finish-load', () => {
    const ip = getLocalIP();
    mainWindow?.webContents.send('local-ip', ip);
  });

  // 启动 WebSocket 服务端
  const server = new DrawSyncServer(
    (msg) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('drawing-message', msg);
      }
    },
    (connected) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('connection-status', connected);
      }
    }
  );
  server.start(8080);

  // 注册 IPC 处理（需要 server 引用以便回发消息给客户端）
  registerIpcHandlers(server);

  mainWindow.on('closed', () => {
    server.stop();
    mainWindow = null;
  });
}

/** 获取本机局域网 IPv4 地址 */
function getLocalIP(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const iface = nets[name];
    if (!iface) continue;
    for (const addr of iface) {
      // 跳过内部回环和 IPv6
      if (addr.family === 'IPv4' && !addr.internal) {
        // 优先返回 192.168.x.x 局域网地址
        if (addr.address.startsWith('192.168.') || addr.address.startsWith('10.') || addr.address.startsWith('172.')) {
          return addr.address;
        }
      }
    }
  }
  return '127.0.0.1';
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
