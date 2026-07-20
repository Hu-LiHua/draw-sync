import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
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

  // 启动 WebSocket 服务端
  const server = new DrawSyncServer(
    (msg) => {
      // 收到 Android 消息，转发到渲染进程
      mainWindow?.webContents.send('drawing-message', msg);
    },
    (connected) => {
      mainWindow?.webContents.send('connection-status', connected);
    }
  );
  server.start(8080);

  mainWindow.on('closed', () => {
    server.stop();
    mainWindow = null;
  });
}

registerIpcHandlers();
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
