# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DrawSync — Android 平板绘图实时同步到 Windows PC。Android (Kotlin) 作为绘图端，通过局域网 WebSocket 将笔触数据实时发送到 Windows Electron 桌面端渲染。

## Build & Run

**Windows Electron 端：**
```bash
cd electron-app && npm run start
```
编译主进程 (CommonJS) + 渲染进程 (ES Module)，复制 HTML/CSS 到 dist，启动 Electron 窗口，监听 8080 端口。

**Android 端：**
```bash
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
需要 Android SDK (`C:\dev_tools\android_sdk`) 和 JDK 21+ (`C:\dev_tools\jdk-21.0.11`)。

## Architecture

### 两套 tsconfig（关键）
- **`tsconfig.json`** — 主进程 (`src/main/**`) → CommonJS，Electron 主进程用
- **`tsconfig.renderer.json`** — 渲染进程 (`src/renderer/**`) → ES2022 模块，浏览器 `<script type="module">` 加载

渲染端 TS 源文件中 import 必须写 `.js` 后缀（如 `import { X } from './data/protocol.js'`），因为 ES Module 在浏览器中按路径解析，TypeScript 原样保留后缀到编译输出。

静态文件 (`index.html`, `styles.css`) 不会被 `tsc` 复制 — `postcompile` 脚本负责拷贝。

### IPC 通信链
```
Android WebSocket → main.ts (DrawSyncServer, ws库)
  → mainWindow.webContents.send('drawing-message' / 'connection-status')
  → preload.ts (ipcRenderer.on + contextBridge 回调)
  → app.ts (渲染进程接收并处理)
```

务必在 `webContents.send()` 前检查 `!mainWindow.webContents.isDestroyed()`，否则关闭窗口时崩溃。

### 坐标缩放
Android 平板分辨率远高于 PC 窗口。`stroke_start` 消息携带 `vw`/`vh`（Android 视图像素尺寸），PC 端 `app.ts` 中 `scalePoints()` 按 `canvasSize / viewSize` 比例缩放所有坐标。如果新增有坐标的消息类型，也需要同样缩放处理。

### 通信协议 (JSON over WebSocket)
所有消息类型见 `electron-app/src/renderer/data/protocol.ts`。
- `stroke_start` — 必须含 `vw`、`vh`
- `stroke_points` — 批量点（Android 每 15 个点刷新一次）
- 橡皮擦：`eraser_stroke`（整条删除）和 `eraser_region_start/end`（区域裁剪）
- `clear`、`undo` — 画布操作
- `set_pen` — 仅通知，PC 端不处理

### 剪贴板复制
`app.ts` 中 `btn-copy` 点击 → 创建离屏 Canvas → `getBoundingBox(20)` 只裁内容区域 → `toBlob` → `electronAPI.copyToClipboard()` → 主进程 `nativeImage.createFromBuffer()` + `clipboard.writeImage()`。
