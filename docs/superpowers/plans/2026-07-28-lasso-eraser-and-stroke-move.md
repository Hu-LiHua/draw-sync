# 套索擦除与笔画移动 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DrawSync 新增统一套索工具——用户画出任意闭合形状，松手后可选"擦除"或"移动"圈中的笔画。

**Architecture:** 协议新增 4 种消息类型（lasso_erase、lasso_select、selection_move、selection_clear）。两端 DrawingState 对称新增 per-page 选中状态、winding number 多边形算法、套索擦除/移动方法。Android DrawView 新增 LASSO 工具模式处理触摸交互；PC 端 app.ts 新增消息处理和 CanvasRenderer 选中高亮。

**Tech Stack:** TypeScript (Electron renderer) + Kotlin (Android) — 与现有项目一致。

## Global Constraints

- TypeScript 端：渲染进程使用 ES Module，import 必须写 `.js` 后缀
- Kotlin 端：最低 SDK API 26+
- 坐标缩放：所有 Android → PC 点和偏移量经 `scalePoints()` 按比例缩放
- undo 机制：修改笔画数据前必须 `pushUndoState()`
- 选中状态：per-page 隔离存储（`Map<number, Set<string>>` / `MutableMap<Int, MutableSet<String>>`）
- 模式切换：必须调用 `resetInProgressOperations()` 清理中间状态
- `pointInPolygon`：使用 winding number 算法 + epsilon 1e-6 容差

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `electron-app/src/renderer/data/protocol.ts` | 修改 | 扩展 WsMessage 联合类型 + ToolMode |
| `electron-app/src/renderer/data/DrawingState.ts` | 修改 | 新增 per-page 选中状态 + winding number + 套索方法 + moveStrokes + resetInProgressOperations |
| `android/.../data/DrawingState.kt` | 修改 | 同上（Kotlin 镜像） |
| `android/.../ui/DrawView.kt` | 修改 | 新增 LASSO 模式 + 自定义 setter + 状态变量 + handleLassoTouch + 渲染更新 |
| `android/.../MainActivity.kt` | 修改 | 新增 btnLasso + 动作浮层 + 回调连线 |
| `android/.../network/WebSocketClient.kt` | 修改 | 新增 4 个 send 方法 + onMessage 扩展点 |
| `electron-app/src/renderer/app.ts` | 修改 | 新增 4 种消息处理 + setToolMode 三路修复 + render() 传 selectedStrokeIds |
| `electron-app/src/renderer/components/CanvasRenderer.ts` | 修改 | render() 签名新增 selectedStrokeIds 参数 + 两次遍历选中高亮 |
| `electron-app/src/renderer/index.html` | 修改 | 工具栏新增 #mode-lasso 按钮 |

---

### Task 1: 扩展协议类型定义

**Files:**
- Modify: `electron-app/src/renderer/data/protocol.ts`

**Interfaces:**
- Produces: `WsMessage` 联合类型新增 4 个变体，`ToolMode` 扩展为 3 值

- [ ] **修改 protocol.ts — 扩展 WsMessage 和 ToolMode**

`electron-app/src/renderer/data/protocol.ts` 第 17-31 行替换为：

```typescript
export type WsMessage =
  | { type: 'stroke_start'; id: string; color: string; width: number; pressure?: number; vw: number; vh: number }
  | { type: 'stroke_points'; id: string; points: Point[] }
  | { type: 'stroke_end'; id: string }
  | { type: 'eraser_stroke'; targetId: string }
  | { type: 'eraser_region_start'; start: Point }
  | { type: 'eraser_region_end'; start: Point; end: Point }
  | { type: 'lasso_erase'; points: Point[] }
  | { type: 'lasso_select'; strokeIds: string[] }
  | { type: 'selection_clear' }
  | { type: 'selection_move'; dx: number; dy: number }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'set_pen'; color: string; width: number }
  | { type: 'page_new' }
  | { type: 'page_go'; pageIdx: number }
  | { type: 'page_delete' };

export type ToolMode = 'eraser-stroke' | 'eraser-region' | 'lasso';
```

- [ ] **验证编译通过**

```bash
cd electron-app && npx tsc --project tsconfig.renderer.json --noEmit
```

预期：编译无错误。

- [ ] **提交**

```bash
git add electron-app/src/renderer/data/protocol.ts
git commit -m "feat(protocol): add lasso_erase, lasso_select, selection_move, selection_clear message types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: TypeScript DrawingState — 新增 per-page 选中 + winding number + 套索方法

**Files:**
- Modify: `electron-app/src/renderer/data/DrawingState.ts`

**Interfaces:**
- Consumes: `Point` from `protocol.ts`
- Produces: `selectStrokes(ids: string[])`, `clearSelection()`, `getSelectedStrokeIds(): Set<string>`, `pointInPolygon(point: Point, polygon: Point[]): boolean`, `getStrokesInLasso(polygon: Point[]): string[]`, `eraseLassoRegion(polygon: Point[]): boolean`, `moveStrokes(ids: string[], dx: number, dy: number): void`, `resetInProgressOperations(): void`

- [ ] **修改 DrawingState.ts — 添加 per-page 选中状态和 winding number 算法**

在 `electron-app/src/renderer/data/DrawingState.ts` 中：

**第 9 行后**（`private historyLimit = 50;` 之后）插入：

```typescript
  /** 每页独立的选中状态 */
  private selectedStrokeIdsByPage: Map<number, Set<string>> = new Map();

  constructor() {
    this.selectedStrokeIdsByPage.set(0, new Set());
  }
```

**在 getter/setter 区域（第 19-21 行后）新增选中状态 getter：**

```typescript
  /** 当前页的选中笔画 ID 集合 */
  private get selectedStrokeIds(): Set<string> {
    if (!this.selectedStrokeIdsByPage.has(this.currentPageIdx)) {
      this.selectedStrokeIdsByPage.set(this.currentPageIdx, new Set());
    }
    return this.selectedStrokeIdsByPage.get(this.currentPageIdx)!;
  }
```

**修改 `newPage()` 方法（第 92-97 行）**，替换为：

```typescript
  newPage(): void {
    const insertIdx = this.currentPageIdx + 1;
    this.pages.splice(insertIdx, 0, []);
    this.undoTimelines.splice(insertIdx, 0, []);
    // 迁移选中状态索引
    const newSelMap = new Map<number, Set<string>>();
    for (const [pageIdx, selSet] of this.selectedStrokeIdsByPage.entries()) {
      newSelMap.set(pageIdx >= insertIdx ? pageIdx + 1 : pageIdx, selSet);
    }
    this.selectedStrokeIdsByPage = newSelMap;
    this.selectedStrokeIdsByPage.set(this.currentPageIdx + 1, new Set());
    this.currentPageIdx++;
    this.currentStroke = null;
  }
```

**修改 `goToPage()` 方法（第 100-105 行）**，替换为：

```typescript
  goToPage(idx: number): boolean {
    if (idx < 0 || idx >= this.pages.length) return false;
    this.currentPageIdx = idx;
    this.currentStroke = null;
    if (!this.selectedStrokeIdsByPage.has(idx)) {
      this.selectedStrokeIdsByPage.set(idx, new Set());
    }
    return true;
  }
```

**修改 `deleteCurrentPage()` 方法（第 108-117 行）**，替换为：

```typescript
  deleteCurrentPage(): boolean {
    if (this.pages.length <= 1) return false;
    const deletedIdx = this.currentPageIdx;
    this.pages.splice(deletedIdx, 1);
    this.undoTimelines.splice(deletedIdx, 1);
    if (this.currentPageIdx >= this.pages.length) {
      this.currentPageIdx = this.pages.length - 1;
    }
    this.selectedStrokeIdsByPage.delete(deletedIdx);
    const newSelMap = new Map<number, Set<string>>();
    for (const [pageIdx, selSet] of this.selectedStrokeIdsByPage.entries()) {
      newSelMap.set(pageIdx > deletedIdx ? pageIdx - 1 : pageIdx, selSet);
    }
    this.selectedStrokeIdsByPage = newSelMap;
    this.currentStroke = null;
    return true;
  }
```

**修改 `clear()` 方法（第 76-80 行）**，替换为：

```typescript
  clear(): void {
    this.pushUndoState();
    this.strokes = [];
    this.currentStroke = null;
    this.selectedStrokeIds.clear();
  }
```

**在 `undo()` 方法后（第 87 行后）新增所有新公共方法：**

```typescript
  // --- 选中状态管理 ---

  selectStrokes(ids: string[]): void {
    this.selectedStrokeIds.clear();
    for (const id of ids) this.selectedStrokeIds.add(id);
  }

  clearSelection(): void {
    this.selectedStrokeIds.clear();
  }

  getSelectedStrokeIds(): Set<string> {
    return this.selectedStrokeIds;
  }

  // --- 多边形工具方法 ---

  /**
   * winding number 算法判断点是否在多边形内。
   * epsilon 1e-6 容差处理 ON_EDGE 情况。
   */
  pointInPolygon(point: Point, polygon: Point[]): boolean {
    const { x: px, y: py } = point;
    const n = polygon.length;
    let wn = 0;

    for (let i = 0; i < n; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];

      // 检查点是否在边上
      const cross = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
      if (Math.abs(cross) < 1e-6) {
        const dot = (px - p1.x) * (p2.x - p1.x) + (py - p1.y) * (p2.y - p1.y);
        if (dot >= 0) {
          const len2 = (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2;
          if (dot <= len2 + 1e-6) return true;
        }
      }

      if (p1.y <= py + 1e-6) {
        if (p2.y > py + 1e-6) {
          const isLeft = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
          if (isLeft > 0) wn++;
        }
      } else {
        if (p2.y <= py + 1e-6) {
          const isLeft = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
          if (isLeft < 0) wn--;
        }
      }
    }
    return wn !== 0;
  }

  /** 返回至少有一个点落入套索多边形的笔画 ID 列表 */
  getStrokesInLasso(polygon: Point[]): string[] {
    const ids: string[] = [];
    for (const stroke of this.strokes) {
      for (const p of stroke.points) {
        if (this.pointInPolygon(p, polygon)) {
          ids.push(stroke.id);
          break;
        }
      }
    }
    return ids;
  }

  /** 套索区域擦除：裁剪落入多边形内的坐标点 */
  eraseLassoRegion(polygon: Point[]): boolean {
    if (polygon.length < 3) return false;
    this.pushUndoState();
    let changed = false;
    for (const stroke of this.strokes) {
      const filtered = stroke.points.filter(p => !this.pointInPolygon(p, polygon));
      if (filtered.length !== stroke.points.length) {
        stroke.points = filtered;
        changed = true;
      }
    }
    this.strokes = this.strokes.filter(s => s.points.length > 0);
    this.clearSelection();
    return changed;
  }

  /** 移动选中笔画 */
  moveStrokes(ids: string[], dx: number, dy: number): void {
    if (ids.length === 0) return;
    this.pushUndoState();
    const idSet = new Set(ids);
    for (const stroke of this.strokes) {
      if (idSet.has(stroke.id)) {
        for (const p of stroke.points) {
          p.x += dx;
          p.y += dy;
        }
      }
    }
  }

  /** 重置所有进行中的操作状态 */
  resetInProgressOperations(): void {
    this.currentStroke = null;
    this.clearSelection();
  }
```

- [ ] **验证编译**

```bash
cd electron-app && npx tsc --project tsconfig.renderer.json --noEmit
```

- [ ] **提交**

```bash
git add electron-app/src/renderer/data/DrawingState.ts
git commit -m "feat(DrawingState): add per-page selection, winding number, lasso erase/move methods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Kotlin DrawingState — 新增 per-page 选中 + winding number + 套索方法

**Files:**
- Modify: `android/app/src/main/java/com/drawsync/app/data/DrawingState.kt`

**Interfaces:**
- Consumes: `Stroke`, `PointF` from same package
- Produces: `selectStrokes(ids: List<String>)`, `clearSelection()`, `getSelectedStrokeIds(): MutableSet<String>`, `pointInPolygon(point: PointF, polygon: List<PointF>): Boolean`, `getStrokesInLasso(polygon: List<PointF>): List<String>`, `eraseLassoRegion(polygon: List<PointF>): Boolean`, `moveStrokes(ids: List<String>, dx: Float, dy: Float)`, `resetInProgressOperations()`

- [ ] **修改 DrawingState.kt**

**第 11 行后**（`private val historyLimit = 50` 之后）插入：

```kotlin
    /** 每页独立的选中状态 */
    private val selectedStrokeIdsByPage = mutableMapOf(0 to mutableSetOf<String>())
```

**第 25 行之后**（`fun getCurrentStroke()` 之前）插入 private getter：

```kotlin
    /** 当前页的选中笔画 ID 集合 */
    private val selectedStrokeIds: MutableSet<String>
        get() = selectedStrokeIdsByPage.getOrPut(currentPageIdx) { mutableSetOf() }
```

**新增公共方法**（`getCurrentStroke()` 之后插入）：

```kotlin
    fun selectStrokes(ids: List<String>) {
        selectedStrokeIds.clear()
        selectedStrokeIds.addAll(ids)
    }

    fun clearSelection() {
        selectedStrokeIds.clear()
    }

    fun getSelectedStrokeIds(): MutableSet<String> = selectedStrokeIds
```

**替换 `newPage()` 方法（第 90-95 行）：**

```kotlin
    fun newPage() {
        val insertIdx = currentPageIdx + 1
        pages.add(insertIdx, mutableListOf())
        undoTimelines.add(insertIdx, Stack())
        // 迁移选中状态索引
        val newSelMap = mutableMapOf<Int, MutableSet<String>>()
        for ((pageIdx, selSet) in selectedStrokeIdsByPage) {
            newSelMap[if (pageIdx >= insertIdx) pageIdx + 1 else pageIdx] = selSet
        }
        selectedStrokeIdsByPage.clear()
        selectedStrokeIdsByPage.putAll(newSelMap)
        currentPageIdx++
        selectedStrokeIdsByPage[currentPageIdx] = mutableSetOf()
        currentStroke = null
    }
```

**替换 `goToPage()` 方法（第 97-102 行）：**

```kotlin
    fun goToPage(idx: Int): Boolean {
        if (idx < 0 || idx >= pages.size) return false
        currentPageIdx = idx
        currentStroke = null
        selectedStrokeIdsByPage.getOrPut(idx) { mutableSetOf() }
        return true
    }
```

**替换 `deleteCurrentPage()` 方法（第 104-111 行）：**

```kotlin
    fun deleteCurrentPage(): Boolean {
        if (pages.size <= 1) return false
        val deletedIdx = currentPageIdx
        pages.removeAt(deletedIdx)
        undoTimelines.removeAt(deletedIdx)
        if (currentPageIdx >= pages.size) currentPageIdx = pages.size - 1
        // 迁移选中状态索引
        selectedStrokeIdsByPage.remove(deletedIdx)
        val newSelMap = mutableMapOf<Int, MutableSet<String>>()
        for ((pageIdx, selSet) in selectedStrokeIdsByPage) {
            newSelMap[if (pageIdx > deletedIdx) pageIdx - 1 else pageIdx] = selSet
        }
        selectedStrokeIdsByPage.clear()
        selectedStrokeIdsByPage.putAll(newSelMap)
        currentStroke = null
        return true
    }
```

**修改 `clear()` 方法（第 74-78 行）末尾添加：**

```kotlin
    fun clear() {
        pushUndoState()
        strokes.clear()
        currentStroke = null
        selectedStrokeIds.clear()
    }
```

**在 `pushUndoState()` 之前插入所有新工具方法：**

```kotlin
    /**
     * winding number 算法判断点是否在多边形内。
     * epsilon 1e-6 容差处理 ON_EDGE 情况。
     */
    fun pointInPolygon(point: PointF, polygon: List<PointF>): Boolean {
        val px = point.x; val py = point.y
        val n = polygon.size
        var wn = 0

        for (i in 0 until n) {
            val p1 = polygon[i]
            val p2 = polygon[(i + 1) % n]

            // 检查点是否在边上
            val cross = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y)
            if (Math.abs(cross) < 1e-6) {
                val dot = (px - p1.x) * (p2.x - p1.x) + (py - p1.y) * (p2.y - p1.y)
                if (dot >= 0) {
                    val len2 = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y)
                    if (dot <= len2 + 1e-6f) return true
                }
            }

            if (p1.y <= py + 1e-6f) {
                if (p2.y > py + 1e-6f) {
                    val isLeft = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y)
                    if (isLeft > 0) wn++
                }
            } else {
                if (p2.y <= py + 1e-6f) {
                    val isLeft = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y)
                    if (isLeft < 0) wn--
                }
            }
        }
        return wn != 0
    }

    /** 返回至少有一个点落入套索多边形的笔画 ID 列表 */
    fun getStrokesInLasso(polygon: List<PointF>): List<String> {
        val ids = mutableListOf<String>()
        for (stroke in strokes) {
            for (p in stroke.points) {
                if (pointInPolygon(p, polygon)) {
                    ids.add(stroke.id)
                    break
                }
            }
        }
        return ids
    }

    /** 套索区域擦除：裁剪落入多边形内的坐标点 */
    fun eraseLassoRegion(polygon: List<PointF>): Boolean {
        if (polygon.size < 3) return false
        pushUndoState()
        var changed = false
        for (stroke in strokes) {
            val before = stroke.points.size
            stroke.points.removeAll { pointInPolygon(it, polygon) }
            if (stroke.points.size != before) changed = true
        }
        strokes.removeAll { it.points.isEmpty() }
        clearSelection()
        return changed
    }

    /** 移动选中笔画 */
    fun moveStrokes(ids: List<String>, dx: Float, dy: Float) {
        if (ids.isEmpty()) return
        pushUndoState()
        val idSet = ids.toSet()
        for (stroke in strokes) {
            if (stroke.id in idSet) {
                for (p in stroke.points) {
                    p.x += dx
                    p.y += dy
                }
            }
        }
    }

    /** 重置所有进行中的操作状态 */
    fun resetInProgressOperations() {
        currentStroke = null
        clearSelection()
    }
```

- [ ] **验证编译**

```bash
cd android && ./gradlew assembleDebug
```

- [ ] **提交**

```bash
git add android/app/src/main/java/com/drawsync/app/data/DrawingState.kt
git commit -m "feat(DrawingState): add per-page selection, winding number, lasso erase/move methods (Android)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Android WebSocketClient — 新增套索消息发送方法

**Files:**
- Modify: `android/app/src/main/java/com/drawsync/app/network/WebSocketClient.kt`

**Interfaces:**
- Produces: `sendLassoErase(points: List<PointF>)`, `sendLassoSelect(strokeIds: List<String>)`, `sendSelectionMove(dx: Float, dy: Float)`, `sendSelectionClear()`
- Modifies: `onMessage` 新增 `"selection_clear"` 分支

- [ ] **新增 4 个发送方法**

在 `sendPageDelete()` 方法之后（第 173 行后）插入：

```kotlin
    fun sendLassoErase(points: List<PointF>) {
        val jsonPoints = JSONArray()
        for (p in points) {
            jsonPoints.put(JSONObject().apply {
                put("x", p.x.toDouble())
                put("y", p.y.toDouble())
            })
        }
        val json = JSONObject().apply {
            put("type", "lasso_erase")
            put("points", jsonPoints)
        }
        webSocket?.send(json.toString())
    }

    fun sendLassoSelect(strokeIds: List<String>) {
        val jsonIds = JSONArray()
        for (id in strokeIds) jsonIds.put(id)
        val json = JSONObject().apply {
            put("type", "lasso_select")
            put("strokeIds", jsonIds)
        }
        webSocket?.send(json.toString())
    }

    fun sendSelectionMove(dx: Float, dy: Float) {
        val json = JSONObject().apply {
            put("type", "selection_move")
            put("dx", dx.toDouble())
            put("dy", dy.toDouble())
        }
        webSocket?.send(json.toString())
    }

    fun sendSelectionClear() {
        webSocket?.send(JSONObject().apply { put("type", "selection_clear") }.toString())
    }
```

- [ ] **onMessage 新增 selection_clear 扩展点**

在 `onMessage` 的 `when` 分支中，`"page_delete"` 之后插入：

```kotlin
                        "selection_clear" -> {
                            // PC→Android 扩展点：当前 Android 端不处理反向 selection_clear
                        }
```

- [ ] **验证编译**

```bash
cd android && ./gradlew assembleDebug
```

- [ ] **提交**

```bash
git add android/app/src/main/java/com/drawsync/app/network/WebSocketClient.kt
git commit -m "feat(WebSocketClient): add lasso_erase, lasso_select, selection_move, selection_clear send methods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Android DrawView — 新增 LASSO 工具模式

**Files:**
- Modify: `android/app/src/main/java/com/drawsync/app/ui/DrawView.kt`

**Interfaces:**
- Consumes: `DrawingState.selectStrokes()`, `getStrokesInLasso()`, `eraseLassoRegion()`, `moveStrokes()`, `getSelectedStrokeIds()`, `clearSelection()`, `resetInProgressOperations()`
- Produces: `onLassoErase`, `onLassoSelect`, `onSelectionMove`, `onSelectionClear` 回调
- Produces: `enterLassoMoveMode(strokeIds)`, `executeLassoErase()`, `cancelLasso()`, `hasPendingLasso()`, `getLastLassoStrokeIds()` 供 Activity 调用
- Modifies: `ToolMode` enum 扩展 `LASSO`，`toolMode` 改为自定义 setter，`onTouchEvent` 新增 LASSO 分支，`onDraw` 新增套索轮廓和选中高亮 + 拖动偏移渲染

- [ ] **新增 import**

在文件顶部 import 区添加：

```kotlin
import android.widget.Toast
```

- [ ] **扩展 ToolMode enum**

第 55 行替换：

```kotlin
    enum class ToolMode { PEN, ERASER_STROKE, ERASER_REGION, LASSO }
```

- [ ] **toolMode 改为自定义 setter**

第 25 行替换：

```kotlin
    var toolMode: ToolMode = ToolMode.PEN
        set(value) {
            field = value
            resetLassoState()
            if (value != ToolMode.LASSO) {
                drawingState.clearSelection()
                drawingState.resetInProgressOperations()
            }
        }
```

- [ ] **新增套索状态变量和 Paint**

在第 53 行 `hitRadius` 之后插入：

```kotlin
    // --- 套索状态 ---
    private val lassoPoints = mutableListOf<PointF>()
    private var lassoActionMode: String? = null // "erase" | "move" | null
    private var dragStartX = 0f
    private var dragStartY = 0f
    private var dragAccumDx = 0f
    private var dragAccumDy = 0f
    private var isDragging = false
    private val selectedStrokeIds = mutableSetOf<String>()

    // 套索轮廓画笔
    private val lassoPaint = Paint().apply {
        color = 0xCC3399FF.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 3f
        isAntiAlias = true
        pathEffect = DashPathEffect(floatArrayOf(10f, 6f), 0f)
    }

    // 选中高亮画笔
    private val highlightPaint = Paint().apply {
        color = 0x803399FF.toInt()
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        isAntiAlias = true
    }
```

- [ ] **新增 4 个回调**

在第 23 行 `onEraserRegionEnd` 之后插入：

```kotlin
    var onLassoErase: ((List<PointF>) -> Unit)? = null
    var onLassoSelect: ((List<String>) -> Unit)? = null
    var onSelectionMove: ((Float, Float) -> Unit)? = null
    var onSelectionClear: (() -> Unit)? = null
```

- [ ] **onTouchEvent 新增 LASSO 分支**

第 100-104 行 `when (toolMode)` 块中新增一行：

```kotlin
            ToolMode.LASSO -> handleLassoTouch(event, x, y)
```

- [ ] **新增 handleLassoTouch / handleLassoDraw / handleLassoDrag**

在 `handleEraserRegionTouch` 之后（第 181 行后）插入：

```kotlin
    private fun handleLassoTouch(event: MotionEvent, x: Float, y: Float) {
        if (lassoActionMode == null) {
            handleLassoDraw(event, x, y)
        } else if (lassoActionMode == "move") {
            handleLassoDrag(event, x, y)
        }
    }

    private fun handleLassoDraw(event: MotionEvent, x: Float, y: Float) {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                lassoPoints.clear()
                lassoPoints.add(PointF(x, y))
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                lassoPoints.add(PointF(x, y))
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                if (lassoPoints.size >= 2) {
                    lassoPoints.add(lassoPoints.first()) // 闭合
                }
                if (lassoPoints.size < 3) {
                    Toast.makeText(context, "请画大一点的圈", Toast.LENGTH_SHORT).show()
                    resetLassoState()
                    invalidate()
                    return
                }
                val ids = drawingState.getStrokesInLasso(lassoPoints.toList())
                if (ids.isEmpty()) {
                    resetLassoState()
                    invalidate()
                    return
                }
                onLassoSelect?.invoke(ids)
                invalidate()
            }
        }
    }

    private fun handleLassoDrag(event: MotionEvent, x: Float, y: Float) {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                dragStartX = x; dragStartY = y
                dragAccumDx = 0f; dragAccumDy = 0f
                isDragging = true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!isDragging) return
                dragAccumDx = x - dragStartX
                dragAccumDy = y - dragStartY
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                isDragging = false
                if (selectedStrokeIds.isNotEmpty()) {
                    val dx = dragAccumDx; val dy = dragAccumDy
                    drawingState.moveStrokes(selectedStrokeIds.toList(), dx, dy)
                    onSelectionMove?.invoke(dx, dy)
                    onSelectionClear?.invoke()
                    drawingState.clearSelection()
                }
                resetLassoState()
                invalidate()
            }
        }
    }

    fun enterLassoMoveMode(strokeIds: List<String>) {
        lassoActionMode = "move"
        selectedStrokeIds.clear()
        selectedStrokeIds.addAll(strokeIds)
        drawingState.selectStrokes(strokeIds)
    }

    fun executeLassoErase(): Boolean {
        val points = lassoPoints.toList()
        val changed = drawingState.eraseLassoRegion(points)
        onLassoErase?.invoke(points)
        resetLassoState()
        drawingState.clearSelection()
        invalidate()
        return changed
    }

    fun cancelLasso() {
        resetLassoState()
        drawingState.clearSelection()
        invalidate()
    }

    fun hasPendingLasso(): Boolean =
        lassoPoints.size >= 3 && lassoActionMode == null

    fun getLastLassoStrokeIds(): List<String> =
        drawingState.getStrokesInLasso(lassoPoints.toList())

    private fun resetLassoState() {
        lassoPoints.clear()
        lassoActionMode = null
        dragStartX = 0f; dragStartY = 0f
        dragAccumDx = 0f; dragAccumDy = 0f
        isDragging = false
    }
```

- [ ] **更新 onDraw — 选中高亮 + 拖动偏移 + 套索轮廓**

替换 `onDraw` 方法（第 57-80 行）：

```kotlin
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        for (stroke in drawingState.strokes) {
            if (isDragging && stroke.id in selectedStrokeIds) {
                canvas.save()
                canvas.translate(dragAccumDx, dragAccumDy)
                drawStroke(canvas, stroke)
                canvas.restore()
                canvas.save()
                canvas.translate(dragAccumDx, dragAccumDy)
                drawHighlightStroke(canvas, stroke)
                canvas.restore()
            } else {
                drawStroke(canvas, stroke)
                if (stroke.id in drawingState.getSelectedStrokeIds()) {
                    drawHighlightStroke(canvas, stroke)
                }
            }
        }

        val current = drawingState.getCurrentStroke()
        if (current != null) drawStroke(canvas, current)

        if (regionStartPoint != null && regionCurrentPoint != null) {
            val left = minOf(regionStartPoint!!.x, regionCurrentPoint!!.x)
            val top = minOf(regionStartPoint!!.y, regionCurrentPoint!!.y)
            val right = maxOf(regionStartPoint!!.x, regionCurrentPoint!!.x)
            val bottom = maxOf(regionStartPoint!!.y, regionCurrentPoint!!.y)
            canvas.drawRect(left, top, right, bottom, eraserPaint)
            canvas.drawRect(left, top, right, bottom, eraserBorderPaint)
        }

        if (lassoPoints.size >= 2) {
            val path = Path()
            path.moveTo(lassoPoints[0].x, lassoPoints[0].y)
            for (i in 1 until lassoPoints.size) {
                path.lineTo(lassoPoints[i].x, lassoPoints[i].y)
            }
            canvas.drawPath(path, lassoPaint)
        }
    }
```

- [ ] **新增 drawHighlightStroke**

在 `drawStroke` 之后插入：

```kotlin
    private fun drawHighlightStroke(canvas: Canvas, stroke: Stroke) {
        if (stroke.points.size < 1) return
        highlightPaint.strokeWidth = stroke.width + 6f
        val path = Path()
        path.moveTo(stroke.points[0].x, stroke.points[0].y)
        for (i in 1 until stroke.points.size) {
            path.lineTo(stroke.points[i].x, stroke.points[i].y)
        }
        canvas.drawPath(path, highlightPaint)
    }
```

- [ ] **验证编译**

```bash
cd android && ./gradlew assembleDebug
```

- [ ] **提交**

```bash
git add android/app/src/main/java/com/drawsync/app/ui/DrawView.kt
git commit -m "feat(DrawView): add LASSO tool mode with draw, move drag, highlight rendering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Android MainActivity — 工具栏套索按钮 + 动作浮层 + 回调连线

**Files:**
- Modify: `android/app/src/main/java/com/drawsync/app/MainActivity.kt`
- May need: `android/app/src/main/res/layout/activity_main.xml`

**Interfaces:**
- Consumes: `DrawView.onLassoErase`, `onLassoSelect`, `onSelectionMove`, `onSelectionClear`, `enterLassoMoveMode()`, `executeLassoErase()`, `cancelLasso()`
- Consumes: `WebSocketClient.sendLassoErase()`, `sendLassoSelect()`, `sendSelectionMove()`, `sendSelectionClear()`

- [ ] **确认 XML 布局**

```bash
grep -n "btnLasso" android/app/src/main/res/layout/activity_main.xml || echo "NOT FOUND"
```

如果不存在，在 XML 中工具栏的 `modeEraserRegion` ToggleButton 之后插入：

```xml
    <ToggleButton
        android:id="@+id/btnLasso"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:textOn="套索"
        android:textOff="套索"
        android:textSize="13sp" />
```

- [ ] **新增 btnLasso 成员变量和初始化**

在第 25 行 `modeEraserRegion` 之后：

```kotlin
    private lateinit var modeLasso: ToggleButton
```

在 `initViews()` 中 `modeEraserRegion` 初始化之后：

```kotlin
        modeLasso = findViewById(R.id.btnLasso)
```

- [ ] **修复所有模式切换监听器的互斥逻辑**

在 `modePen` 监听器（第 106-113 行）中补充 `modeLasso`：

```kotlin
        modePen.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                drawView.toolMode = DrawView.ToolMode.PEN
                modeEraserStroke.isChecked = false
                modeEraserRegion.isChecked = false
                modeLasso.isChecked = false
            } else if (!modeEraserStroke.isChecked && !modeEraserRegion.isChecked && !modeLasso.isChecked) {
                modePen.isChecked = true
            }
        }
```

类似更新 `modeEraserStroke` 和 `modeEraserRegion` 的监听器，添加 `modeLasso.isChecked = false` 和 `!modeLasso.isChecked` 条件。

**新增 `modeLasso` 监听器**（在 `modeEraserRegion` 监听器之后）：

```kotlin
        modeLasso.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                drawView.toolMode = DrawView.ToolMode.LASSO
                modePen.isChecked = false
                modeEraserStroke.isChecked = false
                modeEraserRegion.isChecked = false
            } else if (!modePen.isChecked && !modeEraserStroke.isChecked && !modeEraserRegion.isChecked) {
                modeLasso.isChecked = true
            }
        }
```

- [ ] **setupWebSocket 中新增套索回调连线**

在 `setupWebSocket()` 末尾（第 319 行前）插入：

```kotlin
        drawView.onLassoErase = { points ->
            webSocket?.sendLassoErase(points)
        }
        drawView.onLassoSelect = { ids ->
            showLassoActionBar(ids)
        }
        drawView.onSelectionMove = { dx, dy ->
            webSocket?.sendSelectionMove(dx, dy)
        }
        drawView.onSelectionClear = {
            webSocket?.sendSelectionClear()
        }
```

- [ ] **新增动作浮层方法**

在文件顶部添加 import：

```kotlin
import android.widget.FrameLayout
```

在 `MainActivity` 类末尾（`Int.dp` 之前）插入：

```kotlin
    private var lassoActionBar: LinearLayout? = null

    private fun showLassoActionBar(strokeIds: List<String>) {
        lassoActionBar?.let { (it.parent as? ViewGroup)?.removeView(it) }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(16.dp, 8.dp, 16.dp, 8.dp)
            setBackgroundColor(0xDD333333.toInt())
        }

        val eraseBtn = Button(this).apply {
            text = "🗑️ 擦除"
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFFE53E3E.toInt())
            setOnClickListener {
                drawView.executeLassoErase()
                hideLassoActionBar()
            }
        }
        bar.addView(eraseBtn, LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        ).apply { setMargins(4.dp, 0, 4.dp, 0) })

        val moveBtn = Button(this).apply {
            text = "✋ 移动"
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFF3399FF.toInt())
            setOnClickListener {
                drawView.enterLassoMoveMode(strokeIds)
                webSocket?.sendLassoSelect(strokeIds)
                hideLassoActionBar()
            }
        }
        bar.addView(moveBtn, LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        ).apply { setMargins(4.dp, 0, 4.dp, 0) })

        val params = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM
        ).apply { bottomMargin = toolbar.height + 8.dp }

        (findViewById<FrameLayout>(android.R.id.content) as FrameLayout)
            .addView(bar, params)

        lassoActionBar = bar

        drawView.setOnClickListener {
            drawView.cancelLasso()
            hideLassoActionBar()
        }
    }

    private fun hideLassoActionBar() {
        lassoActionBar?.let { (it.parent as? ViewGroup)?.removeView(it) }
        lassoActionBar = null
    }
```

- [ ] **验证编译**

```bash
cd android && ./gradlew assembleDebug
```

- [ ] **提交**

```bash
git add android/app/src/main/java/com/drawsync/app/MainActivity.kt
git add android/app/src/main/res/layout/activity_main.xml
git commit -m "feat(MainActivity): add lasso tool button, action overlay bar, ws callback wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: PC 端 app.ts — 消息处理 + setToolMode 修复 + render() 传参

**Files:**
- Modify: `electron-app/src/renderer/app.ts`

- [ ] **handleMessage 新增 4 个 case**

在第 102 行 `case 'page_delete':` 块之后、switch 闭合 `}` 之前插入：

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
      drawingState.moveStrokes(
        [...drawingState.getSelectedStrokeIds()],
        msg.dx * sx,
        msg.dy * sy
      );
      break;
    }
```

- [ ] **修复 setToolMode**

第 120-125 行替换为：

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

- [ ] **更新所有 render() 调用**

查找所有 `renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke())` 调用点，全局替换为：

```typescript
renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds())
```

涉及行：16, 104, 130, 134, 151, 160, 168, 175（共 8 处）。

- [ ] **新增 lasso 按钮事件绑定**

在第 118 行之后插入：

```typescript
document.getElementById('mode-lasso')!.addEventListener('click', () => setToolMode('lasso'));
```

- [ ] **验证编译**

```bash
cd electron-app && npx tsc --project tsconfig.renderer.json --noEmit
```

- [ ] **提交**

```bash
git add electron-app/src/renderer/app.ts
git commit -m "feat(app): handle lasso messages, fix setToolMode 3-way, pass selectedStrokeIds to render

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: PC 端 CanvasRenderer — 两次遍历选中高亮

**Files:**
- Modify: `electron-app/src/renderer/components/CanvasRenderer.ts`

- [ ] **修改 render() 签名和逻辑**

替换 `render` 方法（第 24-42 行）为：

```typescript
  render(strokes: StrokeData[], currentStroke: StrokeData | null, selectedStrokeIds?: Set<string>): void {
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;
    this.ctx.clearRect(0, 0, w, h);

    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, w, h);

    for (const stroke of strokes) {
      this.drawStroke(stroke);
    }

    if (currentStroke) {
      this.drawStroke(currentStroke);
    }

    if (selectedStrokeIds && selectedStrokeIds.size > 0) {
      this.ctx.globalAlpha = 0.5;
      for (const stroke of strokes) {
        if (selectedStrokeIds.has(stroke.id)) {
          this.drawHighlightStroke(stroke);
        }
      }
      this.ctx.globalAlpha = 1.0;
    }
  }
```

- [ ] **新增 drawHighlightStroke**

在 `drawStroke` 之后插入：

```typescript
  private drawHighlightStroke(stroke: StrokeData): void {
    if (stroke.points.length < 1) return;
    this.ctx.beginPath();
    this.ctx.strokeStyle = '#3399FF';
    this.ctx.lineWidth = stroke.width + 4;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      this.ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    this.ctx.stroke();
  }
```

- [ ] **验证编译**

```bash
cd electron-app && npx tsc --project tsconfig.renderer.json --noEmit
```

- [ ] **提交**

```bash
git add electron-app/src/renderer/components/CanvasRenderer.ts
git commit -m "feat(CanvasRenderer): add two-pass selection highlight rendering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: PC 端 HTML — 新增套索按钮

**Files:**
- Modify: `electron-app/src/renderer/index.html`

- [ ] **工具栏新增按钮**

在 `index.html` 第 34 行 `mode-eraser-region` 按钮之后插入：

```html
        <button id="mode-lasso" class="mode-btn">套索</button>
```

修改后的 mode-buttons div：

```html
      <div id="mode-buttons">
        <button id="mode-eraser-stroke" class="mode-btn active">擦笔画</button>
        <button id="mode-eraser-region" class="mode-btn">擦区域</button>
        <button id="mode-lasso" class="mode-btn">套索</button>
        <button id="btn-undo" class="action-btn">撤销</button>
        <button id="btn-clear" class="action-btn danger">清空</button>
      </div>
```

- [ ] **验证 UI**

```bash
cd electron-app && npm run start
```

确认工具栏出现"套索"按钮。

- [ ] **提交**

```bash
git add electron-app/src/renderer/index.html
git commit -m "feat(html): add lasso mode button to toolbar

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 联调测试

- [ ] 启动 PC 端：`cd electron-app && npm run start`
- [ ] 编译安装 Android：`cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`
- [ ] 测试套索擦除、套索移动、撤销、翻页隔离、小圈拒绝、模式切换清理、专注模式
- [ ] 修复问题并提交
