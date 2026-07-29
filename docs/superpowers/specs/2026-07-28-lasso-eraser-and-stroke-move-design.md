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

操作序列有严格的时序契约：

```
套索绘制 → lasso_erase 或 (lasso_select → [drag] → selection_move → selection_clear)
```

两种操作路径不可交错：一旦选择擦除或移动，直到操作完成（发送 selection_clear）之前，不会插入其他套索操作。

## 协议变更

`electron-app/src/renderer/data/protocol.ts` — `WsMessage` 类型新增：

```typescript
// 套索擦除：携带套索路径点数组（Android → PC）
| { type: 'lasso_erase'; points: Point[] }

// 套索选中：通知 PC 端高亮哪些笔画（Android → PC）
| { type: 'lasso_select'; strokeIds: string[] }

// 清空选中（Android → PC，当前不反向发送）
| { type: 'selection_clear' }

// 移动选中笔画：携带偏移量（Android → PC）
| { type: 'selection_move'; dx: number; dy: number }
```

注：`selection_clear` 当前仅 Android → PC 方向。Android 端 `WebSocketClient.onMessage` 中预留 `"selection_clear"` 的 when 分支（no-op 或扩展点），以备将来 PC→Android 反向发送。

`ToolMode` 扩展为：`'eraser-stroke' | 'eraser-region' | 'lasso'`

## DrawingState 变更

两端 `DrawingState`（TypeScript / Kotlin）对称实现以下新增内容：

### 选中状态（per-page）

选中状态按页面隔离存储，翻页切换时自动恢复对应页的选中状态：

- **TypeScript**：`private selectedStrokeIdsByPage: Map<number, Set<string>> = new Map()`
- **Kotlin**：`private val selectedStrokeIdsByPage = mutableMapOf<Int, MutableSet<String>>()`

方法（内部通过 `currentPageIdx` 路由到对应页的 Set）：

- `selectStrokes(ids)` — 设置当前页选中笔画
- `clearSelection()` — 清空当前页选中
- `getSelectedStrokeIds()` — 返回当前页已选中笔画 ID 集合（空 Set 而非 null）

`goToPage()`、`newPage()`、`deleteCurrentPage()` 中：
- `goToPage`：切换 pageIdx 即隐式切换到对应页的选中集（per-page 结构天然支持）。**额外**调用 `clearSelection()` 强制新页从非选中状态开始，避免跨页污染。
- `newPage`：新页的 selectedStrokeIds 初始为空 Set。插入到 `selectedStrokeIdsByPage`，后续索引顺移。
- `deleteCurrentPage`：从 `selectedStrokeIdsByPage` 移除对应页的选中集，剩余索引顺移。

### 工具方法

**`pointInPolygon(point, polygon)`** — 使用 **winding number 算法**判断点是否在多边形内，解决射线法的顶点穿越和水平边重合问题：

- winding number = 0 → 点在多边形外
- winding number ≠ 0 → 点在多边形内
- 点恰好在多边形边上（ON_EDGE）：使用 epsilon 容差（1e-6），判定为在内部

**`getStrokesInLasso(polygon)`** — 遍历所有笔画，返回至少有一个点落入多边形的笔画 ID 列表（命中即整条选中）。`polygon` 参数为 PC 画布坐标空间（调用端负责缩放）。

**`eraseLassoRegion(polygon)`** — 遍历所有笔画，过滤掉落入多边形的坐标点，移除变为空的笔画，记录撤销快照。与现有 `eraseRegion()` 逻辑一致，仅判定条件从矩形范围检测替换为 `pointInPolygon`。**末尾调用 `clearSelection()`** 清除残留选中状态。`polygon` 参数为 PC 画布坐标空间。

**`moveStrokes(ids, dx, dy)`** — 遍历指定笔画，将所有点的 x/y 加上 dx/dy，记录撤销快照。`dx/dy` 已在 PC 画布坐标系中。

### 操作状态重置

新增 `resetInProgressOperations()` 方法，清空所有中间状态（currentStroke、套索点、选中集、拖拽状态等）但不影响已持久化的笔画数据。在以下时机调用：

- 切换到不同工具模式时（`toolMode` setter 中）
- 翻页时（`goToPage` / `newPage` / `deleteCurrentPage` 中）
- 专注模式切换时

## Android DrawView 变更

### 新增 `LASSO` 工具模式

```kotlin
enum class ToolMode { PEN, ERASER_STROKE, ERASER_REGION, LASSO }
```

`toolMode` 改为 Kotlin `var` 带自定义 setter，模式切换时自动调用 `resetInProgressOperations()`。

### 状态管理

```
lassoPoints: MutableList<PointF>     // 套索路径点
lassoActionMode: 'erase' | 'move' | null
dragStartX/Y: Float                  // 拖动起点
dragAccumDx/Dy: Float                // 拖动累计偏移（渲染用，不修改数据模型）
isDragging: Boolean
```

### 触摸交互

**套索绘制阶段**（`handleLassoTouch`，`lassoActionMode = null`）：

| 事件 | 行为 |
|------|------|
| `ACTION_DOWN` | 开始收集点，初始化套索路径 |
| `ACTION_MOVE` | 持续收集点，实时重绘套索轮廓 |
| `ACTION_UP` | 自动闭合路径，若点数 < 3 则 toast "请画大一点的圈"并重置；否则底部弹出"擦除"/"移动"浮层 |

**操作选择**：
- 点击"擦除"：
  1. `drawingState.eraseLassoRegion(lassoPoints)`（内部末尾调 `clearSelection()`）
  2. `webSocket?.sendLassoErase(lassoPoints)`
  3. 清空 `lassoPoints`，重置 `lassoActionMode = null`
  4. `invalidate()`
- 点击"移动"：
  1. `drawingState.selectStrokes(drawingState.getStrokesInLasso(lassoPoints))`
  2. `webSocket?.sendLassoSelect(selectedIds)`
  3. 清空 `lassoPoints`，设置 `lassoActionMode = 'move'`
  4. `invalidate()`（触发选中高亮）
- 点击画布空白：清空 `lassoPoints`，重置 `lassoActionMode = null`，`invalidate()`

**拖动阶段**（`lassoActionMode = 'move'`）：

核心策略：**ACTION_MOVE 期间不修改 DrawingState 数据模型，只修改渲染偏移**；ACTION_UP 才一次性写数据模型并记录 undo。

| 事件 | 行为 |
|------|------|
| `ACTION_DOWN` | 记录拖动起点 `dragStartX/Y`，重置 `dragAccumDx/Dy = 0` |
| `ACTION_MOVE` | 计算 `dx = currentX - dragStartX`，`dy = currentY - dragStartY`，更新 `dragAccumDx/Dy`，触发 `invalidate()`（`onDraw` 中根据 `dragAccumDx/Dy` 在绘制选中笔画时临时偏移） |
| `ACTION_UP` | 用最终 `dragAccumDx/Dy` 调用 `drawingState.moveStrokes(selectedIds, dx, dy)` → 发送 `selection_move` → 发送 `selection_clear` → `clearSelection()` → 重置状态 → `invalidate()` |

### 渲染

| 状态 | 渲染效果 |
|------|---------|
| 正在画套索 | 套索路径显示为虚线或半透明轮廓线 |
| 套索完成、待选操作 | 套索轮廓保持 + 底部显示操作浮层 |
| 选中笔画（移动模式） | 笔画外绘制高亮边框 |
| 拖动中 | 选中笔画在 `onDraw` 中临时偏移 `dragAccumDx/Dy` 渲染（数据模型不变） |

### 新增回调

```kotlin
var onLassoErase: ((List<PointF>) -> Unit)? = null
var onLassoSelect: ((List<String>) -> Unit)? = null
var onSelectionMove: ((Float, Float) -> Unit)? = null
var onSelectionClear: (() -> Unit)? = null
```

## Android MainActivity + WebSocketClient 变更

### MainActivity

**工具栏**：新增 `btnLasso` 按钮，与现有三个模式按钮同属一个互斥 ToggleButton 组。默认 PEN 选中。模式切换回调中额外调用 `drawView.resetInProgressOperations()`（或依赖 DrawView 自定义 setter 自动处理）。

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

`onMessage` 的 `when` 分支新增 `"selection_clear"` 处理（当前为 no-op，预留扩展点）。

## PC 端 `app.ts` 变更

### handleMessage 中新增消息处理

```typescript
case 'lasso_erase': {
  const points = scalePoints(msg.points);
  drawingState.eraseLassoRegion(points);  // 内部末尾调 clearSelection()
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

### setToolMode 修复

`ToolMode` 扩展为 `'eraser-stroke' | 'eraser-region' | 'lasso'`。

`setToolMode()` 扩展为显式三路分支：

```typescript
function setToolMode(mode: ToolMode) {
  toolMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  const idMap: Record<ToolMode, string> = {
    'eraser-stroke': 'mode-eraser-stroke',
    'eraser-region': 'mode-eraser-region',
    'lasso': 'mode-lasso',
  };
  document.getElementById(idMap[mode])!.classList.add('active');
}
```

PC 端套索按钮激活时机：`lasso_select` 消息到达时 → 按钮高亮；`selection_clear` / 任何非套索消息到达时 → 取消高亮。

### render() 调用全部传递 selectedStrokeIds

所有 `renderer.render()` 调用点统一传入选中的笔画 ID：

```typescript
renderer.render(
  drawingState.getAllStrokes(),
  drawingState.getCurrentStroke(),
  drawingState.getSelectedStrokeIds()
);
```

## PC 端 `CanvasRenderer` 变更

### 签名变更

```typescript
render(strokes: StrokeData[], currentStroke: StrokeData | null, selectedStrokeIds?: Set<string>): void
```

### 选中高亮

采用两次遍历策略（职责分离清晰）：

1. 第一个循环：正常绘制所有笔画（`drawStroke()` 不变）
2. 第二个循环：检查 `selectedStrokeIds?.has(stroke.id)`，若选中则在该笔画上叠加一层高亮：
   - `strokeStyle = '#3399FF'`，`lineWidth = stroke.width + 4px`，`globalAlpha = 0.5`
   - 绘制完后恢复 `globalAlpha = 1.0`

`drawStroke()` 保持私有，签名不变。

## PC 端 HTML UI

工具栏新增 `#mode-lasso` 按钮，样式与其他模式按钮一致。PC 端不发起套索操作，按钮仅用于显示 Android 端当前工具模式。

## 坐标缩放

| 数据 | 发送方坐标空间 | PC 端如何缩放 |
|------|-------------|-------------|
| `lasso_erase.points` | Android 像素坐标 | `scalePoints()` → PC 画布坐标 |
| `lasso_select.strokeIds` | 无坐标 | 无需缩放 |
| `selection_move.dx/dy` | Android 像素坐标 | `dx * sx, dy * sy` → PC 画布坐标 |

`eraseLassoRegion(polygon)` 和 `getStrokesInLasso(polygon)` 接受的是 PC 画布坐标。调用端负责在传入前完成缩放。

## 状态重置时机汇总

| 触发时机 | 重置内容 |
|---------|---------|
| 切换工具模式（任意模式→任意模式） | `lassoPoints`、`lassoActionMode`、拖拽状态、`selectedStrokeIds`、进行中的矩形擦除状态 |
| 翻页（goToPage/newPage/deletePage） | 同上，切换后新页重新加载其自己的 selectedStrokeIds（默认为空） |
| 专注模式切换 | 同上 |
| eraseLassoRegion 完成 | 内部调用 `clearSelection()` 清除选中 |
| selection_clear 收到 | `clearSelection()` |

## 错误处理与边界情况

| 场景 | 处理 |
|------|------|
| 套索路径点 < 3 个（不构成多边形） | 不执行操作，toast 提示"请画大一点的圈" |
| 套索未选中任何笔画 | 不弹出操作浮层，直接清空套索状态 |
| 自交套索多边形 | winding number 算法正确处理，内部区域判定独立于自交 |
| ON_EDGE（点在多边形边界上） | epsilon 1e-6 容差，判定为内部 |
| 笔画完全被套索包围 / 部分被包围 | 都正确裁剪（按点判断）；套索选中（移动模式）是整条命中的，两者都是逐点裁剪 |
| WebSocket 断连时操作 | 本地操作正常执行，重连后两端通过当前页状态自然同步 |
| 移动操作后消息丢失 | undo 机制覆盖——两端各自维护撤销栈，行为与现有 undo 一致 |
| 翻页 | 翻页后选中状态切换为对应页的选中集（初始为空），套索/拖拽状态全部重置 |
| 专注模式 | 套索按钮在专注模式下隐藏，和现有工具栏行为一致；进入专注模式时重置所有进行中状态 |
| 模式切换中断操作 | 切换模式自动调用 `resetInProgressOperations()`，不会残留中间状态 |
| `selection_move` 时序契约违反 | `lasso_select → [drag] → selection_move → selection_clear` 必须严格顺序且无交错。若收到非预期的消息（如在非选中状态下收到 selection_move），忽略并记录日志 |
| 大套索（密集点）性能 | winding number 对每个笔画点遍历多边形所有边 O(p×n)。套索路径点通常在几十个量级，单页笔画点数在数千量级，性能满足实时要求。如有瓶颈可先做 AABB 粗筛 |

## 测试

1. 画几条笔画 → 切换到套索模式 → 圈住部分 → 选择"擦除" → 验证 PC 端同步裁剪
2. 画几条笔画 → 套索圈住 → 选择"移动" → 拖动到新位置 → 验证两端位置同步、选中高亮消失
3. 撤销套索擦除和套索移动操作
4. 翻页后每页套索选中状态互不影响（翻页即清空新页选中）
5. 断连后套索操作本地不受影响
6. 小圈（< 3 个点）不触发操作
7. 画一个不圈住任何笔画的套索 → 无操作浮层弹出
8. 自交套索圈住部分笔画 → 擦除 → 验证正确的区域被裁减
9. 套索绘制时切换到 PEN 模式 → 套索状态被清理，不会残留
10. 擦除后立即移动 → 二者为独立操作，互不干扰（擦除已调用 clearSelection）
11. 笔画宽度较大时，边缘点因坐标缩放是否正确落入/不落入多边形（验证缩放精度）

## 开发顺序

1. 协议层：扩展 `WsMessage` 和 `ToolMode`
2. 两端 `DrawingState`：per-page 选中状态 + winding number + 多边形工具方法 + `resetInProgressOperations()`
3. Android `DrawView`：新增 LASSO 模式交互（含模式 setter 自动重置状态）
4. Android `MainActivity`：工具栏按钮 + 底部动作浮层
5. Android `WebSocketClient`：新增发送方法 + `selection_clear` 扩展点
6. PC 端 `app.ts`：新增消息处理 + `setToolMode` 修复 + 所有 `render()` 传参 selectedStrokeIds
7. PC 端 `CanvasRenderer`：两次遍历选中高亮
8. PC 端 HTML/CSS：新增套索按钮
9. 联调测试
