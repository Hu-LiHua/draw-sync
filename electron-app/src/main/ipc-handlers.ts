import { ipcMain, clipboard, nativeImage } from 'electron';

export function registerIpcHandlers(): void {
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
}
