# DrawSync — Android 平板绘图实时同步到 Windows 桌面

## 概述

Android 平板上用手指或触控笔绘图，通过局域网 WebSocket 实时同步到 Windows 电脑，支持复制到剪贴板（仅裁剪笔画边界区域）。

## 架构概览

```
┌──────────────────────┐     WebSocket (局域网)     ┌──────────────────────┐
│   Android 平板        │ ◄────────────────────►│   Windows 电脑        │
│                      │   ws://192.168.x.x:8080   │                      │
│  Kotlin + Canvas API │                           │  Electron App        │
│  WebSocket Client    │     笔触数据实时传输        │  WebSocket Server    │
│  本地同步绘制         │                           │  Canvas 渲染         │
│                      │                           │  剪贴板 / 保存       │
└──────────────────────┘                           └──────────────────────┘
```

**推荐方案**：方案一 — 原生 Android + Electron。

## 通信协议

精简 JSON 协议，坐标点批量发送（每帧或每 20 个点合并一次），减少小包数量。

| 消息类型           | 方向                    | 说明                         |
|-------------------|------------------------|------------------------------|
| `stroke_start`    | Android → Windows      | 笔触开始，含颜色、粗细、压力     |
| `stroke_points`   | Android → Windows      | 批量坐标点                     |
| `stroke_end`      | Android → Windows      | 当前笔触结束                   |
| `eraser_stroke`   | Android → Windows      | 按笔触 ID 整条删除             |
| `eraser_region_start` | Android → Windows  | 区域擦除框选起点                |
| `eraser_region_end`   | Android → Windows  | 区域擦除框选终点→裁剪          |
| `clear`           | Android → Windows      | 清空画布                       |
| `undo`            | Android → Windows      | 撤销上一步                     |
| `set_pen`         | Android → Windows      | 同步画笔设置（颜色、粗细）       |

## Android 端设计

### 技术栈
- 语言：Kotlin
- 绘图：原生 Canvas + 自定义 View（onTouchEvent）
- WebSocket：OkHttp WebSocket
- 最低 SDK：API 26+

### UI 布局

```
┌─────────────────────────────┐
│  [● 已连接 192.168.1.100]    │
│                              │
│                              │
│    自由绘图区域               │
│    (自定义 DrawView)         │
│                              │
│                              │
│                              │
├──────────┬────────┬─────────┤
│  颜色  ●  │ 粗细 ──│ ✏️ 🖊️ 📐│
│           清空   撤销         │
└──────────┴────────┴─────────┘
```

底部三种模式切换：**画笔模式** / **笔画擦除模式** / **区域擦除模式**

### 三种绘图模式

| 模式 | 说明 |
|------|------|
| ✏️ 画笔模式 | 自由手绘，可选颜色和粗细 |
| 🖊️ 笔画擦除 | 点击/划过某条笔触 → 整条删除 |
| 📐 区域擦除 | 框选矩形区域 → 裁剪区域内所有笔触 |

### 橡皮擦实现：完美模式

- **笔画擦除**：根据触控点坐标命中的笔触 ID 整条移除
- **区域擦除**：框选的矩形区域对该区域内所有笔触做交集裁剪（计算线段与矩形相交关系，移除被覆盖部分）
- 两端各自维护相同的笔触 ID 序列，保持画布一致

### 核心类结构

```
com.drawsync.app
├── MainActivity.kt              — 主界面
├── ui/
│   ├── DrawView.kt              — 自定义绘图 View（触控 + 渲染）
│   └── ToolbarView.kt           — 底部工具栏（模式切换、颜色、粗细）
├── network/
│   └── WebSocketClient.kt       — WebSocket 连接管理
├── data/
│   ├── Stroke.kt                — 笔触数据模型
│   ├── DrawingState.kt          — 画布状态
│   └── EraseRegion.kt           — 区域擦除数据
└── utils/
    └── BatchPointCollector.kt   — 坐标点批量收集
```

### 关键优化
- 点批量发送：每 16ms 或攒够 20 个点发送一次
- 压力感应：支持触控笔 `MotionEvent.getPressure()`
- 自动重连：断开后每 2 秒重试

## Windows 端设计

### 技术栈
- 框架：Electron + TypeScript
- 渲染：HTML Canvas
- WebSocket 服务端：ws 库
- 剪贴板：Electron clipboard + nativeImage

### UI 布局

```
┌─────────────────────────────────────┐
│  [● 已连接 192.168.1.100]  [复制] [保存]│
│                                     │
│      画布渲染区                       │
│                                     │
│                                     │
├──────────┬──────────┬───────────────┤
│  颜色  ●  │ 粗细 ── │ ✏️ 🖊️ 📐 清空 撤销│
└──────────┴──────────┴───────────────┘
```

### 复制到剪贴板（按笔画边界裁剪）

1. 遍历所有笔触坐标 → 计算最小内容边界框（bbox 周围加 20px padding）
2. 将 Canvas 按 bbox 裁剪导出为 PNG Buffer
3. 通过 `clipboard.writeImage(nativeImage.createFromBuffer())` 写入系统剪贴板
4. 用户可直接粘贴到微信、Word、画图等任何应用中

### 核心文件结构

```
electron-app/
├── main.ts                         — Electron 主进程
├── ipc-handlers.ts                 — IPC 通信（剪贴板、保存等）
├── preload.ts                      — preload 脚本
├── renderer/
│   ├── index.html                  — 页面
│   ├── app.ts                      — 渲染进程入口
│   ├── components/
│   │   └── CanvasRenderer.ts       — Canvas 渲染引擎
│   ├── network/
│   │   └── WebSocketServer.ts      — WebSocket 服务端
│   └── data/
│       └── DrawingState.ts         — 画布状态
└── package.json
```

## 项目目录结构

```
projects/draw-sync/
├── android/                    — Android 端 (Kotlin 项目)
├── electron-app/               — Windows Electron 端
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-07-20-draw-sync-design.md
└── README.md
```

## 开发顺序

1. **Windows Electron 端**（先搞服务端 + 渲染，方便调试）
   - 搭建 Electron + TypeScript 项目
   - 实现 WebSocket 服务端
   - 实现 Canvas 渲染引擎
   - 实现剪贴板复制（裁剪 bbox）
2. **Android 端**
   - 搭建 Kotlin 项目
   - 实现 DrawView 绘图
   - 实现 WebSocket 客户端
   - 实现工具栏（颜色、粗细、模式切换）
   - 实现两种擦除模式
3. **联调测试**
   - 同一局域网下测试实时同步
   - 测试笔画擦除和区域擦除两端一致
   - 测试剪贴板复制功能
