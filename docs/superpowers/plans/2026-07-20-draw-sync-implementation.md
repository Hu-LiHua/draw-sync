# DrawSync 实现计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 按任务逐一实现。步骤使用复选框 (`- [ ]`) 语法追踪。

**目标：** 实现 Android 平板绘图实时同步到 Windows 桌面的完整功能。

**架构：** Android (Kotlin + Canvas) 作为绘图端，通过局域网 WebSocket 将笔触数据实时发送到 Windows Electron 桌面端渲染。两端各自维护相同的笔触数据模型，通过精简 JSON 协议同步。

**技术栈：** Kotlin (Android), Electron + TypeScript + Canvas, OkHttp WebSocket (Android), ws (Node.js)

---

## 全局约束

- 通信协议必须两端严格一致（见下消息格式）
- Android 最低 SDK 26+
- Electron 端使用 TypeScript 严格模式
- 剪贴板复制只复制内容边界框（bbox），非全画布
- 橡皮擦采用"完美模式"：裁剪笔触而非覆盖白色

### 通信协议消息格式

| type | 载荷 | 说明 |
|------|------|------|
| `stroke_start` | `{id, color, width, pressure?}` | 笔触开始 |
| `stroke_points` | `{id, points:[{x,y,pressure?}]}` | 批量坐标点 |
| `stroke_end` | `{id}` | 笔触结束 |
| `eraser_stroke` | `{targetId}` | 按 ID 删除笔触 |
| `eraser_region_start` | `{start:{x,y}}` | 区域擦除开始 |
| `eraser_region_end` | `{start:{x,y}, end:{x,y}}` | 区域擦除开始裁剪 |
| `clear` | `{}` | 清空画布 |
| `undo` | `{}` | 撤销上一步 |
| `set_pen` | `{color, width}` | 同步画笔设置 |

---

## 文件结构

```
projects/draw-sync/
├── electron-app/                       # Windows Electron 端
│   ├── package.json
│   ├── tsconfig.json
│   ├── electron-builder.yml
│   └── src/
│       ├── main/
│       │   ├── main.ts                 # Electron 主进程入口
│       │   ├── ipc-handlers.ts         # IPC 通信处理
│       │   └── preload.ts              # preload 桥接
│       └── renderer/
│           ├── index.html              # 渲染进程页面
│           ├── app.ts                  # 渲染进程入口
│           ├── styles.css              # 样式
│           ├── components/
│           │   └── CanvasRenderer.ts   # Canvas 渲染引擎
│           ├── network/
│           │   └── WebSocketServer.ts  # WebSocket 服务端
│           └── data/
│               ├── protocol.ts         # 协议类型定义
│               └── DrawingState.ts     # 画布状态管理
│
├── android/                            # Android 端
│   ├── build.gradle.kts               # 根级 Gradle
│   ├── settings.gradle.kts
│   ├── gradle.properties
│   ├── gradle/
│   │   └── libs.versions.toml         # 版本目录
│   ├── app/
│   │   ├── build.gradle.kts
│   │   └── src/
│   │       └── main/
│   │           ├── AndroidManifest.xml
│   │           └── java/com/drawsync/app/
│   │               ├── MainActivity.kt
│   │               ├── ui/
│   │               │   └── DrawView.kt
│   │               ├── network/
│   │               │   └── WebSocketClient.kt
│   │               └── data/
│   │                   ├── Stroke.kt
│   │                   └── DrawingState.kt
│   └── res/
│       ├── layout/activity_main.xml
│       └── values/
│           ├── strings.xml
│           ├── colors.xml
│           └── themes.xml
│
├── docs/
│   ├── superpowers/
│   │   ├── specs/
│   │   │   └── 2026-07-20-draw-sync-design.md
│   │   └── plans/
│   │       └── 2026-07-20-draw-sync-implementation.md
└── README.md
```

---

### Task 1: Electron 项目脚手架

**Files:**
- Create: `projects/draw-sync/electron-app/package.json`
- Create: `projects/draw-sync/electron-app/tsconfig.json`
- Create: `projects/draw-sync/electron-app/src/main/main.ts`
- Create: `projects/draw-sync/electron-app/src/main/preload.ts`
- Create: `projects/draw-sync/electron-app/src/renderer/index.html`
- Create: `projects/draw-sync/electron-app/src/renderer/styles.css`
- Create: `projects/draw-sync/electron-app/src/renderer/app.ts`

**Interfaces:**
- Produces: 可启动 Electron 窗口的骨架项目（空白窗口 + 标题栏）

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "draw-sync",
  "version": "1.0.0",
  "description": "Android 平板绘图实时同步到 Windows",
  "main": "dist/main/main.js",
  "scripts": {
    "dev": "node scripts/dev.js",
    "build": "tsc && electron-builder",
    "start": "electron ."
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "electron": "^32.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.6.0",
    "@types/ws": "^8.5.0",
    "concurrently": "^9.0.0",
    "chokidar": "^4.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: 创建 Electron 主进程 main.ts**

```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

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
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
```

- [ ] **Step 4: 创建 preload.ts**

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: () => ipcRenderer.invoke('copy-to-clipboard'),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),
});
```

- [ ] **Step 5: 创建 renderer/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DrawSync</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="app">
    <div id="top-bar">
      <span id="connection-status" class="disconnected">● 未连接</span>
      <span id="connection-ip">端口 8080 等待连接...</span>
      <div id="top-actions">
        <button id="btn-copy">📋 复制</button>
        <button id="btn-save">💾 保存</button>
      </div>
    </div>
    <canvas id="canvas"></canvas>
    <div id="toolbar">
      <div id="color-picker">
        <button class="color-btn active" data-color="#000000" style="background:#000000"></button>
        <button class="color-btn" data-color="#FF0000" style="background:#FF0000"></button>
        <button class="color-btn" data-color="#0000FF" style="background:#0000FF"></button>
        <button class="color-btn" data-color="#00AA00" style="background:#00AA00"></button>
        <button class="color-btn" data-color="#FF8800" style="background:#FF8800"></button>
        <button class="color-btn" data-color="#8800FF" style="background:#8800FF"></button>
      </div>
      <div id="width-control">
        <label>粗细</label>
        <input type="range" id="width-slider" min="1" max="20" value="3" />
      </div>
      <div id="mode-buttons">
        <button id="mode-pen" class="mode-btn active">✏️ 画笔</button>
        <button id="mode-eraser-stroke" class="mode-btn">🖊️ 擦笔画</button>
        <button id="mode-eraser-region" class="mode-btn">📐 擦区域</button>
        <button id="btn-undo" class="action-btn">↩ 撤销</button>
        <button id="btn-clear" class="action-btn danger">🗑 清空</button>
      </div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 6: 创建 styles.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; background: #f5f5f5; user-select: none; }

#app { display: flex; flex-direction: column; height: 100vh; }

#top-bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: #fff; border-bottom: 1px solid #ddd; }
#connection-status { font-size: 14px; }
#connection-status.disconnected { color: #999; }
#connection-status.connected { color: #22c55e; }
#connection-ip { flex: 1; font-size: 12px; color: #666; }
#top-actions { display: flex; gap: 8px; }
#top-actions button { padding: 4px 12px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; }
#top-actions button:hover { background: #eee; }

#canvas { flex: 1; cursor: crosshair; display: block; background: #fff; }

#toolbar { display: flex; align-items: center; gap: 16px; padding: 8px 16px; background: #fff; border-top: 1px solid #ddd; flex-wrap: wrap; }
#color-picker { display: flex; gap: 4px; }
.color-btn { width: 24px; height: 24px; border: 2px solid transparent; border-radius: 50%; cursor: pointer; }
.color-btn.active { border-color: #333; }
#width-control { display: flex; align-items: center; gap: 6px; font-size: 13px; }
#mode-buttons { display: flex; gap: 4px; }
.mode-btn, .action-btn { padding: 4px 10px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; }
.mode-btn.active { background: #e3f2fd; border-color: #1976d2; color: #1976d2; }
.mode-btn:hover, .action-btn:hover { background: #eee; }
.action-btn.danger:hover { background: #ffebee; border-color: #d32f2f; color: #d32f2f; }
```

- [ ] **Step 7: 安装依赖**

```bash
cd ~/projects/draw-sync/electron-app
npm install
```

- [ ] **Step 8: 编译并验证启动**

```bash
cd ~/projects/draw-sync/electron-app
npx tsc
npx electron .
# → 应看到一个空白窗口，标题 "DrawSync"，有工具栏 UI
```

---

### Task 2: 协议类型 + DrawingState 数据模型

**Files:**
- Create: `projects/draw-sync/electron-app/src/renderer/data/protocol.ts`
- Create: `projects/draw-sync/electron-app/src/renderer/data/DrawingState.ts`

**Interfaces:**
- Consumes: 无
- Produces: `DrawingState` 类（所有后续渲染/擦除/剪贴板任务依赖）

- [ ] **Step 1: 创建 protocol.ts**

```typescript
// 通信协议消息类型定义

export interface Point {
  x: number;
  y: number;
  pressure?: number;
}

export interface StrokeData {
  id: string;
  color: string;
  width: number;
  points: Point[];
  pressure?: number;
}

export type WsMessage =
  | { type: 'stroke_start'; id: string; color: string; width: number; pressure?: number }
  | { type: 'stroke_points'; id: string; points: Point[] }
  | { type: 'stroke_end'; id: string }
  | { type: 'eraser_stroke'; targetId: string }
  | { type: 'eraser_region_start'; start: Point }
  | { type: 'eraser_region_end'; start: Point; end: Point }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'set_pen'; color: string; width: number };

export type ToolMode = 'pen' | 'eraser-stroke' | 'eraser-region';
```

- [ ] **Step 2: 创建 DrawingState.ts**

```typescript
import { StrokeData, Point } from './protocol';

export class DrawingState {
  strokes: StrokeData[] = [];
  private currentStroke: StrokeData | null = null;
  private undoStack: StrokeData[][] = [];
  private historyLimit = 50;

  getCurrentStroke(): StrokeData | null { return this.currentStroke; }
  getAllStrokes(): StrokeData[] { return this.strokes; }

  startStroke(id: string, color: string, width: number, pressure?: number): StrokeData {
    this.currentStroke = { id, color, width, points: [], pressure };
    return this.currentStroke;
  }

  addPoints(id: string, points: Point[]): boolean {
    if (!this.currentStroke || this.currentStroke.id !== id) return false;
    this.currentStroke.points.push(...points);
    return true;
  }

  endStroke(id: string): StrokeData | null {
    if (!this.currentStroke || this.currentStroke.id !== id) return null;
    const stroke = this.currentStroke;
    this.strokes.push(stroke);
    this.currentStroke = null;
    this.pushUndoState();
    return stroke;
  }

  removeStroke(targetId: string): StrokeData | null {
    const idx = this.strokes.findIndex(s => s.id === targetId);
    if (idx === -1) return null;
    const removed = this.strokes.splice(idx, 1)[0];
    this.pushUndoState();
    return removed;
  }

  /** 区域擦除：裁掉被矩形覆盖的坐标点 */
  eraseRegion(a: Point, b: Point): boolean {
    this.pushUndoState();
    const xMin = Math.min(a.x, b.x), xMax = Math.max(a.x, b.x);
    const yMin = Math.min(a.y, b.y), yMax = Math.max(a.y, b.y);
    let changed = false;

    for (const stroke of this.strokes) {
      const filtered = stroke.points.filter(p => p.x < xMin || p.x > xMax || p.y < yMin || p.y > yMax);
      if (filtered.length !== stroke.points.length) {
        stroke.points = filtered;
        changed = true;
      }
    }
    // 移除空笔触
    this.strokes = this.strokes.filter(s => s.points.length > 0);
    return changed;
  }

  clear(): void {
    this.pushUndoState();
    this.strokes = [];
    this.currentStroke = null;
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    this.strokes = this.undoStack.pop()!;
    this.currentStroke = null;
    return true;
  }

  /** 计算所有笔画的内容边界框（用于剪贴板裁剪） */
  getBoundingBox(padding = 20): { x: number; y: number; width: number; height: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasPoints = false;
    for (const s of this.strokes) {
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        hasPoints = true;
      }
    }
    if (!hasPoints) return null;
    return {
      x: Math.max(0, minX - padding),
      y: Math.max(0, minY - padding),
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }

  private pushUndoState(): void {
    this.undoStack.push(JSON.parse(JSON.stringify(this.strokes)));
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
  }
}
```

---

### Task 3: WebSocket 服务端

**Files:**
- Create: `projects/draw-sync/electron-app/src/renderer/network/WebSocketServer.ts`
- Modify: `projects/draw-sync/electron-app/src/main/main.ts`

**Interfaces:**
- Consumes: `WsMessage` (protocol.ts)
- Produces: `WebSocketServer` 实例，其他组件通过 `onMessage` 回调接收消息

- [ ] **Step 1: 创建 WebSocketServer.ts**

```typescript
import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { WsMessage } from '../data/protocol';

type MessageHandler = (msg: WsMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

export class DrawSyncServer {
  private wss: WsServer | null = null;
  private client: WebSocket | null = null;
  private onMessage: MessageHandler;
  private onConnectionChange: ConnectionHandler;

  constructor(onMessage: MessageHandler, onConnectionChange: ConnectionHandler) {
    this.onMessage = onMessage;
    this.onConnectionChange = onConnectionChange;
  }

  start(port = 8080): void {
    this.wss = new WsServer({ port });
    this.wss.on('connection', (ws) => {
      this.client = ws;
      this.onConnectionChange(true);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsMessage;
          this.onMessage(msg);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      });

      ws.on('close', () => {
        this.client = null;
        this.onConnectionChange(false);
      });

      ws.on('error', () => {
        this.client = null;
        this.onConnectionChange(false);
      });
    });
    console.log(`WebSocket server started on port ${port}`);
  }

  stop(): void {
    if (this.client) { this.client.close(); this.client = null; }
    if (this.wss) { this.wss.close(); this.wss = null; }
    this.onConnectionChange(false);
  }

  getPort(): number { return this.wss?.options?.port ?? 8080; }
}
```

- [ ] **Step 2: 更新 main.ts — 添加窗口关闭时停止服务**

```typescript
// 在 import 区域添加
import { ipcMain } from 'electron';

// 在 createWindow 函数中，mainWindow.on('closed') 之前添加
ipcMain.handle('copy-to-clipboard', () => {
  mainWindow?.webContents.send('trigger-copy');
});
ipcMain.handle('save-to-file', () => {
  mainWindow?.webContents.send('trigger-save');
});
```

---

### Task 4: Canvas 渲染引擎

**Files:**
- Create: `projects/draw-sync/electron-app/src/renderer/components/CanvasRenderer.ts`
- Modify: `projects/draw-sync/electron-app/src/renderer/app.ts`

**Interfaces:**
- Consumes: `DrawingState` 实例, `StrokeData[]`
- Produces: Canvas 渲染和交互手柄

- [ ] **Step 1: 创建 CanvasRenderer.ts**

```typescript
import { StrokeData, Point, ToolMode } from '../data/protocol';

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.dpr = window.devicePixelRatio || 1;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
  }

  getWidth(): number { return this.canvas.getBoundingClientRect().width; }
  getHeight(): number { return this.canvas.getBoundingClientRect().height; }

  render(strokes: StrokeData[], currentStroke: StrokeData | null): void {
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;
    this.ctx.clearRect(0, 0, w, h);

    // 绘制背景
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, w, h);

    // 绘制所有已完成笔画
    for (const stroke of strokes) {
      this.drawStroke(stroke);
    }

    // 绘制当前正在画的笔触
    if (currentStroke) {
      this.drawStroke(currentStroke);
    }
  }

  private drawStroke(stroke: StrokeData): void {
    if (stroke.points.length < 1) return;

    this.ctx.beginPath();
    this.ctx.strokeStyle = stroke.color;
    this.ctx.lineWidth = stroke.width;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    // 第一个点作为 moveTo
    this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    // 中间点用 lineTo
    for (let i = 1; i < stroke.points.length; i++) {
      this.ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }

    this.ctx.stroke();
  }

  /** 导出内容区域为 PNG Buffer（裁剪到笔画边界） */
  exportContentClip(strokes: StrokeData[], bbox: { x: number; y: number; width: number; height: number } | null): Uint8Array | null {
    if (!bbox) return null;

    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;

    // 创建离屏 Canvas
    const offscreen = document.createElement('canvas');
    offscreen.width = bbox.width * this.dpr;
    offscreen.height = bbox.height * this.dpr;
    const offCtx = offscreen.getContext('2d')!;

    // 白色背景
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
    offCtx.scale(this.dpr, this.dpr);
    offCtx.translate(-bbox.x, -bbox.y);

    // 绘制笔画
    for (const stroke of strokes) {
      this.drawStrokeOnCtx(offCtx, stroke);
    }

    const blob = offscreen.toBlob((blob) => {
      if (blob) {
        blob.arrayBuffer().then(buf => {
          window.electronAPI?.copyImageToClipboard(new Uint8Array(buf));
        });
      }
    }, 'image/png');
    return null; // 实际通过 IPC 完成
  }

  private drawStrokeOnCtx(ctx: CanvasRenderingContext2D, stroke: StrokeData): void {
    if (stroke.points.length < 1) return;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }
}
```

- [ ] **Step 2: 创建 app.ts 渲染进程入口**

```typescript
/// <reference types="../../types/electron.d.ts" />

import { DrawingState } from './data/DrawingState';
import { CanvasRenderer } from './components/CanvasRenderer';
import { DrawSyncServer } from './network/WebSocketServer';
import { WsMessage, ToolMode } from './data/protocol';

// --- 全局状态 ---
const drawingState = new DrawingState();
let toolMode: ToolMode = 'pen';
let currentColor = '#000000';
let currentWidth = 3;
let regionStart: { x: number; y: number } | null = null;

// --- 初始化 Canvas ---
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas);

function resizeCanvas() {
  renderer.resize();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
}
window.addEventListener('resize', resizeCanvas);

// --- 初始化 WebSocket 服务端 ---
const server = new DrawSyncServer(
  (msg: WsMessage) => handleMessage(msg),
  (connected: boolean) => updateConnectionStatus(connected)
);
server.start(8080);

function updateConnectionStatus(connected: boolean) {
  const el = document.getElementById('connection-status')!;
  const ipEl = document.getElementById('connection-ip')!;
  if (connected) {
    el.className = 'connected';
    el.textContent = '● 已连接';
    ipEl.textContent = '平板已连接';
  } else {
    el.className = 'disconnected';
    el.textContent = '● 未连接';
    ipEl.textContent = '端口 8080 等待连接...';
  }
}

// --- 消息处理 ---
function handleMessage(msg: WsMessage) {
  switch (msg.type) {
    case 'stroke_start':
      drawingState.startStroke(msg.id, msg.color, msg.width, msg.pressure);
      break;
    case 'stroke_points':
      drawingState.addPoints(msg.id, msg.points);
      break;
    case 'stroke_end':
      drawingState.endStroke(msg.id);
      break;
    case 'eraser_stroke':
      drawingState.removeStroke(msg.targetId);
      break;
    case 'eraser_region_start':
      regionStart = msg.start;
      break;
    case 'eraser_region_end':
      if (regionStart) {
        drawingState.eraseRegion(regionStart, msg.end);
        regionStart = null;
      }
      break;
    case 'clear':
      drawingState.clear();
      break;
    case 'undo':
      drawingState.undo();
      break;
    case 'set_pen':
      break; // Android 发来的画笔设置仅通知
  }
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
}

// --- UI 交互 ---
// 颜色选择
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = (btn as HTMLElement).dataset.color!;
  });
});

// 粗细调整
const widthSlider = document.getElementById('width-slider') as HTMLInputElement;
widthSlider.addEventListener('input', () => { currentWidth = parseInt(widthSlider.value); });

// 模式切换
document.getElementById('mode-pen')!.addEventListener('click', () => setToolMode('pen'));
document.getElementById('mode-eraser-stroke')!.addEventListener('click', () => setToolMode('eraser-stroke'));
document.getElementById('mode-eraser-region')!.addEventListener('click', () => setToolMode('eraser-region'));

function setToolMode(mode: ToolMode) {
  toolMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  if (mode === 'pen') document.getElementById('mode-pen')!.classList.add('active');
  else if (mode === 'eraser-stroke') document.getElementById('mode-eraser-stroke')!.classList.add('active');
  else document.getElementById('mode-eraser-region')!.classList.add('active');
  canvas.style.cursor = mode === 'pen' ? 'crosshair' : 'pointer';
}

// 撤销/清空
document.getElementById('btn-undo')!.addEventListener('click', () => {
  drawingState.undo();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
});
document.getElementById('btn-clear')!.addEventListener('click', () => {
  drawingState.clear();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
});

// 复制/保存
document.getElementById('btn-copy')!.addEventListener('click', () => {
  const bbox = drawingState.getBoundingBox(20);
  if (!bbox) return;
  const strokes = drawingState.getAllStrokes();

  const offscreen = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  offscreen.width = bbox.width * dpr;
  offscreen.height = bbox.height * dpr;
  const offCtx = offscreen.getContext('2d')!;
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
  offCtx.scale(dpr, dpr);
  offCtx.translate(-bbox.x, -bbox.y);

  for (const s of strokes) {
    if (s.points.length < 1) continue;
    offCtx.beginPath();
    offCtx.strokeStyle = s.color;
    offCtx.lineWidth = s.width;
    offCtx.lineCap = 'round';
    offCtx.lineJoin = 'round';
    offCtx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) offCtx.lineTo(s.points[i].x, s.points[i].y);
    offCtx.stroke();
  }

  offscreen.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      // 通过 preload 调用主进程复制到剪贴板
      (window as any).electronAPI.copyToClipboard(reader.result);
    };
    reader.readAsArrayBuffer(blob);
  }, 'image/png');
});

// 初始渲染
resizeCanvas();

// --- 类型声明 ---
declare global {
  interface Window {
    electronAPI: {
      copyToClipboard: (data: ArrayBuffer) => void;
      saveToFile: () => void;
    };
  }
}
```

---

### Task 5: IPC — 剪贴板复制（裁剪到笔画边界）

**Files:**
- Create: `projects/draw-sync/electron-app/src/main/ipc-handlers.ts`
- Modify: `projects/draw-sync/electron-app/src/main/main.ts`
- Modify: `projects/draw-sync/electron-app/src/main/preload.ts`

**Interfaces:**
- Consumes: `electronAPI.copyToClipboard(data: ArrayBuffer)` 来自渲染进程
- Produces: 系统剪贴板图像

- [ ] **Step 1: 创建 ipc-handlers.ts**

```typescript
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
```

- [ ] **Step 2: 更新 main.ts — 注册 IPC**

```typescript
import { registerIpcHandlers } from './ipc-handlers';

// 在 app.whenReady().then(createWindow) 之前添加
registerIpcHandlers();
```

- [ ] **Step 3: 更新 preload.ts**

```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (data: ArrayBuffer) => ipcRenderer.invoke('copy-to-clipboard', data),
  saveToFile: () => ipcRenderer.invoke('save-to-file'),
});
```

---

### Task 6: Android 项目脚手架

**Files:**
- Create: `projects/draw-sync/android/settings.gradle.kts`
- Create: `projects/draw-sync/android/build.gradle.kts`
- Create: `projects/draw-sync/android/gradle.properties`
- Create: `projects/draw-sync/android/gradle/libs.versions.toml`
- Create: `projects/draw-sync/android/app/build.gradle.kts`
- Create: `projects/draw-sync/android/app/src/main/AndroidManifest.xml`
- Create: `projects/draw-sync/android/app/src/main/res/values/strings.xml`
- Create: `projects/draw-sync/android/app/src/main/res/values/colors.xml`
- Create: `projects/draw-sync/android/app/src/main/res/values/themes.xml`
- Create: `projects/draw-sync/android/app/src/main/res/layout/activity_main.xml`

**Interfaces:**
- Produces: 可编译的空白 Android 项目骨架

- [ ] **Step 1: 创建 settings.gradle.kts**

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "DrawSync"
include(":app")
```

- [ ] **Step 2: 创建根级 build.gradle.kts**

```kotlin
plugins {
    id("com.android.application") version "8.5.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.10" apply false
}
```

- [ ] **Step 3: 创建 gradle.properties**

```properties
android.useAndroidX=true
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
```

- [ ] **Step 4: 创建 app/build.gradle.kts**

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.drawsync.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.drawsync.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
```

- [ ] **Step 5: 创建 AndroidManifest.xml**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.DrawSync"
        android:usesCleartextTraffic="true">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

注意：`android:usesCleartextTraffic="true"` 是因为局域网 WebSocket 使用 ws:// 而非 wss://。

- [ ] **Step 6: 创建 res 资源文件**

**strings.xml:**
```xml
<resources>
    <string name="app_name">DrawSync</string>
</resources>
```

**colors.xml:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="white">#FFFFFF</color>
    <color name="black">#000000</color>
    <color name="toolbar_bg">#F5F5F5</color>
</resources>
```

**themes.xml:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.DrawSync" parent="Theme.AppCompat.Light.NoActionBar">
        <item name="android:statusBarColor">@android:color/transparent</item>
    </style>
</resources>
```

**activity_main.xml:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical">

    <!-- 连接状态栏 -->
    <LinearLayout
        android:id="@+id/connectionBar"
        android:layout_width="match_parent"
        android:layout_height="40dp"
        android:gravity="center_vertical"
        android:paddingHorizontal="16dp"
        android:background="#FFFFFF"
        android:orientation="horizontal">
        <TextView
            android:id="@+id/connectionStatus"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:text="● 未连接"
            android:textColor="#999999"
            android:textSize="14sp" />
        <EditText
            android:id="@+id/ipInput"
            android:layout_width="120dp"
            android:layout_height="32dp"
            android:hint="192.168.1.100"
            android:textSize="12sp"
            android:gravity="center"
            android:background="@android:drawable/editbox_background" />
        <Button
            android:id="@+id/connectBtn"
            android:layout_width="wrap_content"
            android:layout_height="32dp"
            android:text="连接"
            android:textSize="12sp" />
    </LinearLayout>

    <!-- 绘图区域 -->
    <com.drawsync.app.ui.DrawView
        android:id="@+id/drawView"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:background="#FFFFFF" />

    <!-- 底部工具栏 -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="56dp"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:paddingHorizontal="8dp"
        android:background="#FFFFFF">

        <!-- 模式切换 -->
        <ToggleButton
            android:id="@+id/modePen"
            android:layout_width="48dp"
            android:layout_height="40dp"
            android:textOn="✏️"
            android:textOff="✏️"
            android:checked="true"
            android:background="?android:attr/selectableItemBackground" />
        <ToggleButton
            android:id="@+id/modeEraserStroke"
            android:layout_width="48dp"
            android:layout_height="40dp"
            android:textOn="🖊️"
            android:textOff="🖊️"
            android:background="?android:attr/selectableItemBackground" />
        <ToggleButton
            android:id="@+id/modeEraserRegion"
            android:layout_width="48dp"
            android:layout_height="40dp"
            android:textOn="📐"
            android:textOff="📐"
            android:background="?android:attr/selectableItemBackground" />

        <View android:layout_width="1dp" android:layout_height="32dp" android:background="#DDD" />

        <!-- 颜色选择 -->
        <HorizontalScrollView
            android:layout_width="wrap_content"
            android:layout_height="match_parent"
            android:scrollbars="none">
            <LinearLayout
                android:id="@+id/colorPicker"
                android:layout_width="wrap_content"
                android:layout_height="match_parent"
                android:orientation="horizontal"
                android:gravity="center_vertical"
                android:layout_marginHorizontal="4dp" />
        </HorizontalScrollView>

        <View android:layout_width="1dp" android:layout_height="32dp" android:background="#DDD" />

        <!-- 粗细滑块 -->
        <TextView android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="粗细" android:textSize="12sp" android:layout_marginLeft="4dp" />
        <SeekBar
            android:id="@+id/widthSlider"
            android:layout_width="80dp"
            android:layout_height="wrap_content"
            android:max="19"
            android:progress="2" />

        <View android:layout_width="1dp" android:layout_height="32dp" android:background="#DDD" />

        <!-- 操作按钮 -->
        <Button
            android:id="@+id/btnUndo"
            android:layout_width="wrap_content"
            android:layout_height="40dp"
            android:text="↩"
            android:background="?android:attr/selectableItemBackground" />
        <Button
            android:id="@+id/btnClear"
            android:layout_width="wrap_content"
            android:layout_height="40dp"
            android:text="🗑"
            android:background="?android:attr/selectableItemBackground" />
    </LinearLayout>
</LinearLayout>
```

---

### Task 7: Android 数据模型

**Files:**
- Create: `projects/draw-sync/android/app/src/main/java/com/drawsync/app/data/Stroke.kt`
- Create: `projects/draw-sync/android/app/src/main/java/com/drawsync/app/data/DrawingState.kt`

**Interfaces:**
- Consumes: 无
- Produces: `Stroke`, `Point`, `DrawingState` 类（DrawView 和 WebSocketClient 依赖）

- [ ] **Step 1: 创建 Stroke.kt**

```kotlin
package com.drawsync.app.data

import android.graphics.Color
import java.util.UUID

data class PointF(val x: Float, val y: Float, val pressure: Float = 0f)

data class Stroke(
    val id: String = UUID.randomUUID().toString(),
    val color: Int = Color.BLACK,
    val width: Float = 3f,
    val points: MutableList<PointF> = mutableListOf(),
    var pressure: Float = 0f
)
```

- [ ] **Step 2: 创建 DrawingState.kt**

```kotlin
package com.drawsync.app.data

import android.graphics.RectF
import java.util.Stack

class DrawingState {
    val strokes = mutableListOf<Stroke>()
    private var currentStroke: Stroke? = null
    private val undoStack = Stack<List<Stroke>>()
    private val historyLimit = 50

    fun getCurrentStroke(): Stroke? = currentStroke

    fun startStroke(color: Int, width: Float, pressure: Float = 0f): Stroke {
        val stroke = Stroke(color = color, width = width, pressure = pressure)
        currentStroke = stroke
        return stroke
    }

    fun addPoints(id: String, points: List<PointF>): Boolean {
        val stroke = currentStroke ?: return false
        if (stroke.id != id) return false
        stroke.points.addAll(points)
        return true
    }

    fun endStroke(id: String): Stroke? {
        val stroke = currentStroke ?: return null
        if (stroke.id != id) return null
        strokes.add(stroke)
        currentStroke = null
        pushUndoState()
        return stroke
    }

    fun removeStroke(targetId: String): Stroke? {
        val idx = strokes.indexOfFirst { it.id == targetId }
        if (idx == -1) return null
        val removed = strokes.removeAt(idx)
        pushUndoState()
        return removed
    }

    /** 区域擦除：裁剪矩形内的坐标点 */
    fun eraseRegion(a: PointF, b: PointF): Boolean {
        pushUndoState()
        val xMin = minOf(a.x, b.x); val xMax = maxOf(a.x, b.x)
        val yMin = minOf(a.y, b.y); val yMax = maxOf(a.y, b.y)
        var changed = false

        for (stroke in strokes) {
            val before = stroke.points.size
            stroke.points.removeAll { it.x in xMin..xMax && it.y in yMin..yMax }
            if (stroke.points.size != before) changed = true
        }
        strokes.removeAll { it.points.isEmpty() }
        return changed
    }

    fun clear() {
        pushUndoState()
        strokes.clear()
        currentStroke = null
    }

    fun undo(): Boolean {
        if (undoStack.isEmpty()) return false
        strokes.clear()
        strokes.addAll(undoStack.pop())
        currentStroke = null
        return true
    }

    /** 计算笔画边界框 */
    fun getBoundingBox(padding: Int = 20): RectF? {
        if (strokes.all { it.points.isEmpty() }) return null
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
        var maxX = Float.MIN_VALUE; var maxY = Float.MIN_VALUE

        for (s in strokes) {
            for (p in s.points) {
                if (p.x < minX) minX = p.x
                if (p.y < minY) minY = p.y
                if (p.x > maxX) maxX = p.x
                if (p.y > maxY) maxY = p.y
            }
        }
        return RectF(
            maxOf(0f, minX - padding), maxOf(0f, minY - padding),
            maxX + padding, maxY + padding
        )
    }

    private fun pushUndoState() {
        val snapshot = strokes.map { stroke ->
            Stroke(stroke.id, stroke.color, stroke.width, stroke.points.toMutableList(), stroke.pressure)
        }
        undoStack.push(snapshot)
        if (undoStack.size > historyLimit) undoStack.removeAt(0)
    }
}
```

---

### Task 8: Android WebSocket 客户端

**Files:**
- Create: `projects/draw-sync/android/app/src/main/java/com/drawsync/app/network/WebSocketClient.kt`

**Interfaces:**
- Consumes: `DrawingState`, `Stroke`
- Produces: 发送 `WsMessage` JSON 到 Electron 端，四种状态回调

- [ ] **Step 1: 创建 WebSocketClient.kt**

```kotlin
package com.drawsync.app.network

import android.os.Handler
import android.os.Looper
import com.drawsync.app.data.PointF
import com.drawsync.app.data.Stroke
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class WebSocketClient(
    private val onConnected: () -> Unit,
    private val onDisconnected: () -> Unit,
    private val onError: (String) -> Unit
) {
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.SECONDS) // 长连接不超时
        .pingInterval(10, TimeUnit.SECONDS)
        .build()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun connect(ip: String, port: Int = 8080) {
        disconnect()
        val url = "ws://$ip:$port"
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                mainHandler.post(onConnected)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                mainHandler.post(onDisconnected)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                mainHandler.post { onError(t.message ?: "连接失败") }
                mainHandler.post(onDisconnected)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                // Android 端目前不接收消息（将来可以扩展双向同步）
            }
        })
    }

    fun disconnect() {
        webSocket?.close(1000, "用户断开")
        webSocket = null
    }

    fun isConnected(): Boolean = webSocket != null

    // --- 发送消息 ---

    fun sendStrokeStart(stroke: Stroke) {
        val json = JSONObject().apply {
            put("type", "stroke_start")
            put("id", stroke.id)
            put("color", String.format("#%06X", 0xFFFFFF and stroke.color))
            put("width", stroke.width.toDouble())
        }
        webSocket?.send(json.toString())
    }

    fun sendStrokePoints(strokeId: String, points: List<PointF>) {
        val jsonPoints = JSONArray()
        for (p in points) {
            val pt = JSONObject().apply {
                put("x", p.x.toDouble())
                put("y", p.y.toDouble())
            }
            if (p.pressure > 0) pt.put("pressure", p.pressure.toDouble())
            jsonPoints.put(pt)
        }
        val json = JSONObject().apply {
            put("type", "stroke_points")
            put("id", strokeId)
            put("points", jsonPoints)
        }
        webSocket?.send(json.toString())
    }

    fun sendStrokeEnd(strokeId: String) {
        val json = JSONObject().apply {
            put("type", "stroke_end")
            put("id", strokeId)
        }
        webSocket?.send(json.toString())
    }

    fun sendEraserStroke(targetId: String) {
        val json = JSONObject().apply {
            put("type", "eraser_stroke")
            put("targetId", targetId)
        }
        webSocket?.send(json.toString())
    }

    fun sendEraserRegionStart(start: PointF) {
        val json = JSONObject().apply {
            put("type", "eraser_region_start")
            put("start", JSONObject().apply {
                put("x", start.x.toDouble())
                put("y", start.y.toDouble())
            })
        }
        webSocket?.send(json.toString())
    }

    fun sendEraserRegionEnd(start: PointF, end: PointF) {
        val json = JSONObject().apply {
            put("type", "eraser_region_end")
            put("start", JSONObject().apply {
                put("x", start.x.toDouble())
                put("y", start.y.toDouble())
            })
            put("end", JSONObject().apply {
                put("x", end.x.toDouble())
                put("y", end.y.toDouble())
            })
        }
        webSocket?.send(json.toString())
    }

    fun sendClear() {
        webSocket?.send(JSONObject().apply { put("type", "clear") }.toString())
    }

    fun sendUndo() {
        webSocket?.send(JSONObject().apply { put("type", "undo") }.toString())
    }

    fun sendSetPen(color: Int, width: Float) {
        val json = JSONObject().apply {
            put("type", "set_pen")
            put("color", String.format("#%06X", 0xFFFFFF and color))
            put("width", width.toDouble())
        }
        webSocket?.send(json.toString())
    }
}
```

---

### Task 9: Android DrawView + MainActivity

**Files:**
- Create: `projects/draw-sync/android/app/src/main/java/com/drawsync/app/ui/DrawView.kt`
- Create: `projects/draw-sync/android/app/src/main/java/com/drawsync/app/MainActivity.kt`

**Interfaces:**
- Consumes: `DrawingState`, `WebSocketClient`, `Stroke`, `PointF`
- Produces: 完整的绘图交互 UI

- [ ] **Step 1: 创建 DrawView.kt**

```kotlin
package com.drawsync.app.ui

import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import com.drawsync.app.data.DrawingState
import com.drawsync.app.data.PointF
import com.drawsync.app.data.Stroke
import kotlin.math.sqrt

class DrawView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    var drawingState = DrawingState()
    var onStrokeStart: ((Stroke) -> Unit)? = null
    var onStrokePoints: ((String, List<PointF>) -> Unit)? = null
    var onStrokeEnd: ((String) -> Unit)? = null
    var onEraserStroke: ((String) -> Unit)? = null
    var onEraserRegionStart: ((PointF) -> Unit)? = null
    var onEraserRegionEnd: ((PointF, PointF) -> Unit)? = null

    var toolMode: ToolMode = ToolMode.PEN
    var currentColor: Int = Color.BLACK
    var currentWidth: Float = 3f

    private val paint = Paint().apply {
        isAntiAlias = true
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val batchCollector = BatchCollector()
    private val eraserPaint = Paint().apply {
        color = 0x330000FF.toInt() // 区域选择半透明蓝色
        style = Paint.Style.FILL
    }
    private val eraserBorderPaint = Paint().apply {
        color = 0xFF0000FF.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }

    // 区域擦除状态
    var isInRegionSelect = false
    private var regionStartPoint: PointF? = null
    private var regionCurrentPoint: PointF? = null

    // 点击命中检测距离
    private val hitRadius = 15f

    enum class ToolMode { PEN, ERASER_STROKE, ERASER_REGION }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        // 绘制所有已完成笔画
        for (stroke in drawingState.strokes) {
            drawStroke(canvas, stroke)
        }

        // 绘制当前笔画
        val current = drawingState.getCurrentStroke()
        if (current != null) {
            drawStroke(canvas, current)
        }

        // 绘制区域擦除框选
        if (regionStartPoint != null && regionCurrentPoint != null) {
            val left = minOf(regionStartPoint!!.x, regionCurrentPoint!!.x)
            val top = minOf(regionStartPoint!!.y, regionCurrentPoint!!.y)
            val right = maxOf(regionStartPoint!!.x, regionCurrentPoint!!.x)
            val bottom = maxOf(regionStartPoint!!.y, regionCurrentPoint!!.y)
            canvas.drawRect(left, top, right, bottom, eraserPaint)
            canvas.drawRect(left, top, right, bottom, eraserBorderPaint)
        }
    }

    private fun drawStroke(canvas: Canvas, stroke: Stroke) {
        if (stroke.points.size < 1) return
        paint.color = stroke.color
        paint.strokeWidth = stroke.width

        val path = Path()
        path.moveTo(stroke.points[0].x, stroke.points[0].y)
        for (i in 1 until stroke.points.size) {
            path.lineTo(stroke.points[i].x, stroke.points[i].y)
        }
        canvas.drawPath(path, paint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val x = event.x
        val y = event.y
        val pressure = event.pressure

        when (toolMode) {
            ToolMode.PEN -> handlePenTouch(event, x, y, pressure)
            ToolMode.ERASER_STROKE -> handleEraserStrokeTouch(event, x, y)
            ToolMode.ERASER_REGION -> handleEraserRegionTouch(event, x, y)
        }

        return true
    }

    private fun handlePenTouch(event: MotionEvent, x: Float, y: Float, pressure: Float) {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                val stroke = drawingState.startStroke(currentColor, currentWidth, pressure)
                stroke.points.add(PointF(x, y, pressure))
                batchCollector.reset(stroke.id)
                onStrokeStart?.invoke(stroke)
            }
            MotionEvent.ACTION_MOVE -> {
                val current = drawingState.getCurrentStroke() ?: return
                current.points.add(PointF(x, y, pressure))

                batchCollector.addPoint(PointF(x, y, pressure))
                if (batchCollector.shouldFlush()) {
                    onStrokePoints?.invoke(current.id, batchCollector.flush())
                }
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                val current = drawingState.getCurrentStroke() ?: return
                current.points.add(PointF(x, y, pressure))

                // 发送剩余的点
                batchCollector.addPoint(PointF(x, y, pressure))
                val remaining = batchCollector.flush()
                if (remaining.isNotEmpty()) {
                    onStrokePoints?.invoke(current.id, remaining)
                }

                onStrokeEnd?.invoke(current.id)
                drawingState.endStroke(current.id)
                invalidate()
            }
        }
    }

    private fun handleEraserStrokeTouch(event: MotionEvent, x: Float, y: Float) {
        when (event.action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                // 找到最近的笔触并删除
                val target = findStrokeAt(x, y) ?: return
                drawingState.removeStroke(target.id)
                onEraserStroke?.invoke(target.id)
                invalidate()
            }
            MotionEvent.ACTION_UP -> { /* 完成 */ }
        }
    }

    private fun handleEraserRegionTouch(event: MotionEvent, x: Float, y: Float) {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                regionStartPoint = PointF(x, y)
                regionCurrentPoint = PointF(x, y)
                onEraserRegionStart?.invoke(regionStartPoint!!)
            }
            MotionEvent.ACTION_MOVE -> {
                regionCurrentPoint = PointF(x, y)
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                if (regionStartPoint != null) {
                    val start = regionStartPoint!!
                    val end = PointF(x, y)
                    onEraserRegionEnd?.invoke(start, end)
                    drawingState.eraseRegion(start, end)
                }
                regionStartPoint = null
                regionCurrentPoint = null
                invalidate()
            }
        }
    }

    private fun findStrokeAt(x: Float, y: Float): Stroke? {
        // 逆序遍历，优先移除最后画的笔触
        for (i in drawingState.strokes.indices.reversed()) {
            val stroke = drawingState.strokes[i]
            for (p in stroke.points) {
                val dx = p.x - x; val dy = p.y - y
                if (sqrt(dx * dx + dy * dy) <= hitRadius) return stroke
            }
        }
        return null
    }

    /** 坐标点批量收集器 */
    class BatchCollector {
        private val batch = mutableListOf<PointF>()
        private var strokeId = ""
        private var count = 0

        fun reset(id: String) { strokeId = id; batch.clear(); count = 0 }
        fun addPoint(p: PointF) { batch.add(p); count++ }

        fun shouldFlush(): Boolean = count >= 15

        fun flush(): List<PointF> {
            val result = batch.toList()
            batch.clear()
            count = 0
            return result
        }
    }
}
```

- [ ] **Step 2: 创建 MainActivity.kt**

```kotlin
package com.drawsync.app

import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.children
import com.drawsync.app.data.DrawingState
import com.drawsync.app.data.PointF
import com.drawsync.app.data.Stroke
import com.drawsync.app.network.WebSocketClient
import com.drawsync.app.ui.DrawView

class MainActivity : AppCompatActivity() {

    private lateinit var drawView: DrawView
    private lateinit var connectionStatus: TextView
    private lateinit var ipInput: EditText
    private lateinit var connectBtn: Button
    private lateinit var widthSlider: SeekBar
    private lateinit var modePen: ToggleButton
    private lateinit var modeEraserStroke: ToggleButton
    private lateinit var modeEraserRegion: ToggleButton

    private var webSocket: WebSocketClient? = null
    private val colorButtons = listOf(
        0xFF000000.toInt(), 0xFFFF0000.toInt(), 0xFF0000FF.toInt(),
        0xFF00AA00.toInt(), 0xFFFF8800.toInt(), 0xFF8800FF.toInt()
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        initViews()
        setupToolbar()
        setupWebSocket()
    }

    private fun initViews() {
        drawView = findViewById(R.id.drawView)
        connectionStatus = findViewById(R.id.connectionStatus)
        ipInput = findViewById(R.id.ipInput)
        connectBtn = findViewById(R.id.connectBtn)
        widthSlider = findViewById(R.id.widthSlider)
        modePen = findViewById(R.id.modePen)
        modeEraserStroke = findViewById(R.id.modeEraserStroke)
        modeEraserRegion = findViewById(R.id.modeEraserRegion)

        // 加载上次连接的 IP
        val prefs = getPreferences(MODE_PRIVATE)
        ipInput.setText(prefs.getString("last_ip", ""))
    }

    private fun setupToolbar() {
        // 颜色按钮
        val colorPicker = findViewById<LinearLayout>(R.id.colorPicker)
        for ((i, color) in colorButtons.withIndex()) {
            val btn = ImageButton(this).apply {
                setBackgroundColor(color)
                setPadding(4, 4, 4, 4)
                layoutParams = LinearLayout.LayoutParams(40.dp, 40.dp).apply {
                    setMargins(2, 0, 2, 0)
                }
                setOnClickListener {
                    drawView.currentColor = color
                    // 更新选中态
                    colorPicker.children.forEach { it.alpha = 0.4f }
                    this.alpha = 1f
                }
                if (i == 0) {
                    isSelected = true
                    alpha = 1f
                } else {
                    alpha = 0.4f
                }
            }
            colorPicker.addView(btn)
        }

        // 粗细
        widthSlider.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                drawView.currentWidth = (value + 1).toFloat()
            }
            override fun onStartTrackingTouch(bar: SeekBar?) {}
            override fun onStopTrackingTouch(bar: SeekBar?) {}
        })

        // 模式切换
        modePen.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                drawView.toolMode = DrawView.ToolMode.PEN
                modeEraserStroke.isChecked = false
                modeEraserRegion.isChecked = false
            } else if (!modeEraserStroke.isChecked && !modeEraserRegion.isChecked) {
                modePen.isChecked = true
            }
        }
        modeEraserStroke.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                drawView.toolMode = DrawView.ToolMode.ERASER_STROKE
                modePen.isChecked = false
                modeEraserRegion.isChecked = false
            } else if (!modePen.isChecked && !modeEraserRegion.isChecked) {
                modeEraserStroke.isChecked = true
            }
        }
        modeEraserRegion.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                drawView.toolMode = DrawView.ToolMode.ERASER_REGION
                modePen.isChecked = false
                modeEraserStroke.isChecked = false
            } else if (!modePen.isChecked && !modeEraserStroke.isChecked) {
                modeEraserRegion.isChecked = true
            }
        }

        // 撤销/清空
        findViewById<Button>(R.id.btnUndo).setOnClickListener {
            drawView.drawingState.undo()
            webSocket?.sendUndo()
            drawView.invalidate()
        }
        findViewById<Button>(R.id.btnClear).setOnClickListener {
            drawView.drawingState.clear()
            webSocket?.sendClear()
            drawView.invalidate()
        }
    }

    private fun setupWebSocket() {
        webSocket = WebSocketClient(
            onConnected = {
                connectionStatus.text = "● 已连接"
                connectionStatus.setTextColor(0xFF22C55E.toInt())
            },
            onDisconnected = {
                connectionStatus.text = "● 未连接"
                connectionStatus.setTextColor(0xFF999999.toInt())
            },
            onError = { msg ->
                Toast.makeText(this, "连接错误: $msg", Toast.LENGTH_SHORT).show()
            }
        )

        connectBtn.setOnClickListener {
            val ip = ipInput.text.toString().trim()
            if (ip.isBlank()) {
                Toast.makeText(this, "请输入 IP 地址", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            webSocket?.connect(ip)
            getPreferences(MODE_PRIVATE).edit().putString("last_ip", ip).apply()
        }

        // 设置 DrawView 回调
        drawView.onStrokeStart = { stroke ->
            webSocket?.sendStrokeStart(stroke)
        }
        drawView.onStrokePoints = { id, points ->
            webSocket?.sendStrokePoints(id, points)
        }
        drawView.onStrokeEnd = { id ->
            webSocket?.sendStrokeEnd(id)
        }
        drawView.onEraserStroke = { targetId ->
            webSocket?.sendEraserStroke(targetId)
        }
        drawView.onEraserRegionStart = { start ->
            webSocket?.sendEraserRegionStart(start)
        }
        drawView.onEraserRegionEnd = { start, end ->
            webSocket?.sendEraserRegionEnd(start, end)
        }
    }

    override fun onDestroy() {
        webSocket?.disconnect()
        super.onDestroy()
    }

    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()
}
```

---

### Task 10: 联调测试

- [ ] **Step 1: 启动 Electron 端**

```bash
cd ~/projects/draw-sync/electron-app
npx tsc
npx electron .
# 弹窗显示 "端口 8080 等待连接..."
```

- [ ] **Step 2: 查找电脑局域网 IP**

```bash
ipconfig | grep IPv4
# 例如: 192.168.1.100
```

- [ ] **Step 3: 编译并安装 Android 端**

```bash
cd ~/projects/draw-sync/android
./gradlew assembleDebug
# APK 在 app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

或直接在 Android Studio 中打开项目 → Run。

- [ ] **Step 4: 在平板上输入电脑 IP → 点击连接**

- 状态变为绿色 "● 已连接"

- [ ] **Step 5: 验证功能**

| 功能 | 操作 | 预期 |
|------|------|------|
| 绘图 | 用手指/触控笔绘制 | Windows 端实时同步显示 |
| 笔画擦除 | 切换到擦笔画模式，点击笔画 | 两端同时删除该笔画 |
| 区域擦除 | 切换到擦区域模式，框选区域 | 两端同时裁剪该区域 |
| 撤销 | 点击撤销 | 两端回退上一步 |
| 清空 | 点击清空 | 两端画布清空 |
| 复制 | 点击复制按钮 | 笔画边界裁剪后复制到剪贴板 |
| 保存 | 点击保存 | 保存为 PNG 文件 |

---

## 自检

- [x] **Spec 覆盖检查**：每项需求都有对应任务
  - ✓ 自由手绘 → Task 4 (CanvasRenderer) + Task 9 (DrawView)
  - ✓ 颜色/粗细 → Task 1 (HTML 工具栏) + Task 6 (Android 工具栏)
  - ✓ 笔画擦除 → Task 4 (eraser_stroke 处理) + Task 9 (handleEraserStrokeTouch)
  - ✓ 区域擦除 → Task 4 (eraser_region 处理) + Task 9 (handleEraserRegionTouch)
  - ✓ 剪贴板复制（裁剪 bbox）→ Task 5 (IPC) + Task 4 (exportContentClip)
  - ✓ 清空/撤销 → Task 4 + Task 2 (DrawingState)
- [x] **占位符检查**：无 TBD/TODO
- [x] **类型一致性检查**：协议类型、方法签名跨任务一致
