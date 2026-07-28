# DrawSync — 套索擦除与笔画移动

## 概述

在现有矩形区域擦除和点击整条擦除基础上，新增**统一套索工具**：用户画出任意闭合形状，松手后可选择"擦除"或"移动"圈中的笔画内容。

## 交互流程

```
工具栏切换到套索模式 → 手指画套索 → 松手自动闭合
  → 底部弹出 [🗑️ 擦除] [✋ 移动] 两个按钮
    → 擦除：套索内坐标点被裁剪掉
    → 移动：套索圈住的整条笔画高亮，手指拖动移动到新位置
    → 点击空白 → 取消
```

## 协议变更

`electron-app/src/renderer/data/protocol.ts` — `WsMessage` 类型新增：

```typescript
// 套索擦除：携带套索路径点数组
| { type: 'lasso_erase'; points: Point[] }

// 套索选中：通知 PC 端高亮哪些笔画
| { type: 'lasso_select'; strokeIds: string[] }

// 清空选中（双向）
| { type: 'selection_clear' }

// 移动选中笔画：携带偏移量
| { type: 'selection_move'; dx: number; dy: number }
```

`ToolMode` 扩展为：`'eraser-stroke' | 'eraser-region' | 'lasso'`

## DrawingState 变更

两端 `DrawingState`（TypeScript / Kotlin）对称实现以下新增内容：

### 选中状态

- `selectedStrokeIds: Set<string>` / `MutableSet<String>`
- `selectStrokes(ids)` — 设置选中笔画
- `clearSelection()` — 清空选中
- `getSelectedStrokeIds()` — 获取已选中笔画 ID 集合

### 工具方法

**`pointInPolygon(point, polygon)`** — 射线法判断点是否在多边形内。从目标点向右发水平射线，统计与多边形边交点数：奇数在内，偶数在外。

**`getStrokesInLasso(polygon)`** — 遍历所有笔画，返回至少有一个点落入多边形的笔画 ID 列表（命中即整条选中）。

**`eraseLassoRegion(polygon)`** — 遍历所有笔画，过滤掉落入多边形的坐标点，移除变为空的笔画，记录撤销快照。与现有 `eraseRegion()` 逻辑一致，仅判定条件从矩形范围检测替换为多边形包含检测。

**`moveStrokes(ids, dx, dy)`** — 遍历指定笔画，将所有点的 x/y 加上 dx/dy，记录撤销快照。

### 动作栏浮层

画完套索松手后，底部动态弹出两个按钮。点击按钮执行对应操作后浮层消失；点击画布空白区域也取消。

该浮层在 Android 端为代码动态创建的 LinearLayout；PC 端不需要（PC 端不发起套索操作）。

## Android DrawView 变更

### 新增 `LASSO` 工具模式

```kotlin
enum class ToolMode { PEN, ERASER_STROKE, ERASER_REGION, LASSO }
```

### 状态管理

```
lassoPoints: MutableList<PointF>     // 套索路径点
lassoActionMode: 'erase' | 'move' | null
dragStartX/Y: Float                  // 拖动起点
isDragging: Boolean
```

### 触摸交互

**套索绘制阶段**（`handleLassoTouch`，`lassoActionMode = null`）：

| 事件 | 行为 |
|------|------|
| `ACTION_DOWN` | 开始收集点，初始化套索路径 |
| `ACTION_MOVE` | 持续收集点，实时重绘套索轮廓 |
| `ACTION_UP` | 自动闭合路径，底部弹出"擦除"/"移动"浮层 |

**操作选择**：
- 点击"擦除"：调 `eraseLassoRegion()` → 发送 `lasso_erase` WebSocket 消息 → 清空套索状态
- 点击"移动"：调 `getStrokesInLasso()` 获取选中笔画 → 发送 `lasso_select` → 高亮选中 → 等待拖动
- 点击画布空白：取消操作，清空套索状态

**拖动阶段**（`lassoActionMode = 'move'`）：

| 事件 | 行为 |
|------|------|
| `ACTION_DOWN` | 记录拖动起点 `dragStartX/Y` |
| `ACTION_MOVE` | 计算偏移量，实时更新笔画坐标（即时视觉反馈），持续重绘 |
| `ACTION_UP` | 应用最终偏移到数据模型 `moveStrokes()` → 发送 `selection_move` → 发送 `selection_clear` |

### 渲染

| 状态 | 渲染效果 |
|------|---------|
| 正在画套索 | 套索路径显示为虚线或半透明轮廓线 |
| 套索完成、待选操作 | 套索轮廓保持 + 底部显示操作浮层 |
| 选中笔画（移动模式） | 笔画外绘制高亮边框 |
| 拖动中 | 笔画随手指实时移动 |

### 新增回调

```kotlin
var onLassoErase: ((List<PointF>) -> Unit)? = null
var onLassoSelect: ((List<String>) -> Unit)? = null
var onSelectionMove: ((Float, Float) -> Unit)? = null
var onSelectionClear: (() -> Unit)? = null
```

## Android MainActivity + WebSocketClient 变更

### MainActivity

**工具栏**：新增 `btnLasso` 按钮，与现有三个模式按钮同属一个互斥 ToggleButton 组。默认 PEN 选中。

**动作浮层**：代码动态创建的水平 LinearLayout，两个按钮（擦除 / 移动），位于画布底部、工具栏上方。点击任一后消失并执行对应操作；点击画布空白消失。

**回调连线**：
```kotlin
drawView.onLassoErase = { points -> webSocket?.sendLassoErase(points) }
drawView.onLassoSelect = { ids -> webSocket?.sendLassoSelect(ids) }
drawView.onSelectionMove = { dx, dy -> webSocket?.sendSelectionMove(dx, dy) }
drawView.onSelectionClear = { webSocket?.sendSelectionClear() }
```

### WebSocketClient

新增方法：

| 方法 | JSON payload |
|------|-------------|
| `sendLassoErase(points)` | `{"type":"lasso_erase","points":[...]}` |
| `sendLassoSelect(strokeIds)` | `{"type":"lasso_select","strokeIds":[...]}` |
| `sendSelectionMove(dx, dy)` | `{"type":"selection_move","dx":...,"dy":...}` |
| `sendSelectionClear()` | `{"type":"selection_clear"}` |

## PC 端 `app.ts` 变更

在 `handleMessage` 的 switch 中新增消息处理：

```typescript
case 'lasso_erase': {
  const points = scalePoints(msg.points);
  drawingState.eraseLassoRegion(points);
  break;
}
case 'lasso_select':
  drawingState.selectStrokes(msg.strokeIds);
  break;
case 'selection_clear':
  drawingState.clearSelection();
  break;
case 'selection_move': {
  const sx = renderer.getWidth() / androidVw;
  const sy = renderer.getHeight() / androidVh;
  drawingState.moveStrokes(drawingState.getSelectedStrokeIds(), msg.dx * sx, msg.dy * sy);
  break;
}
```

`toolMode` 扩展为 `'eraser-stroke' | 'eraser-region' | 'lasso'`。

所有消息处理后调用 `renderer.render()`，传入选中的笔画 ID 集合用于高亮。

## PC 端 `CanvasRenderer` 变更

### 签名变更

```typescript
render(strokes: StrokeData[], currentStroke: StrokeData | null, selectedStrokeIds?: Set<string>): void
```

### 选中高亮

遍历笔画时检查 `selectedStrokeIds?.has(stroke.id)`，如果选中则：
- 先绘制原有笔画（正常颜色/粗细/alpha）
- 再在一层上绘制略粗的选中线（`stroke.width + 4px`），颜色 `#3399FF`，`globalAlpha = 0.5`

## PC 端 HTML UI

工具栏新增 `#mode-lasso` 按钮，样式与其他模式按钮一致。PC 端不发起套索操作，按钮仅用于状态显示。

## 坐标缩放

所有 Android → PC 的坐标点和偏移量统一通过 `scalePoints()` 按比例缩放。PC 端接收到的套索点和移动偏移量经缩放后转换为 PC 画布坐标。

## 错误处理与边界情况

| 场景 | 处理 |
|------|------|
| 套索路径点 < 3 个（不构成多边形） | 不执行操作，toast 提示"请画大一点的圈" |
| 套索未选中任何笔画 | 不弹出操作浮层，直接清空套索状态 |
| WebSocket 断连时操作 | 本地操作正常执行，重连后两端通过当前页状态自然同步 |
| 移动操作后消息丢失 | undo 机制覆盖——两端各自维护撤销栈，行为与现有 undo 一致 |
| 翻页 | 翻页后选中状态自动清空，套索状态重置，每页独立 |
| 专注模式 | 套索模式和专注模式不冲突——套索按钮在专注模式下隐藏，和现有工具栏行为一致 |

## 测试

1. 画几条笔画 → 切换到套索模式 → 圈住部分 → 选择"擦除" → 验证 PC 端同步裁剪
2. 画几条笔画 → 套索圈住 → 选择"移动" → 拖动到新位置 → 验证两端位置同步
3. 撤销套索擦除和套索移动操作
4. 翻页后每页套索操作互不影响
5. 断连后套索操作本地不受影响
6. 小圈（< 3 个点）不触发操作
7. 画一个不圈住任何笔画的套索 → 无操作浮层弹出

## 开发顺序

1. 协议层：扩展 `WsMessage` 和 `ToolMode`
2. 两端 `DrawingState`：新增多边形工具方法 + 选中状态
3. Android `DrawView`：新增 LASSO 模式交互
4. Android `MainActivity`：工具栏按钮 + 底部动作浮层
5. Android `WebSocketClient`：新增发送方法
6. PC 端 `app.ts`：新增消息处理
7. PC 端 `CanvasRenderer`：新增选中高亮
8. PC 端 HTML/CSS：新增套索按钮
9. 联调测试
