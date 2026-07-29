import { ipcMain, clipboard, nativeImage } from 'electron';
import { DrawSyncServer } from './WebSocketServer';
import { WsMessage } from '../renderer/data/protocol';

export function registerIpcHandlers(server: DrawSyncServer): void {
  ipcMain.handle('copy-to-clipboard', (_event, data: ArrayBuffer) => {
    const buffer = Buffer.from(data);
    const image = nativeImage.createFromBuffer(buffer);
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle('save-to-file', () => {
    // 保存功能由渲染进程通过 canvas.toBlob 实现
    return true;
  });

  /** PC 端翻页 → 回发给 Android 客户端同步 */
  ipcMain.on('send-to-client', (_event, msg: WsMessage) => {
    server.send(msg);
  });
}
