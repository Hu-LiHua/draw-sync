package com.drawsync.app.data

import android.graphics.RectF
import java.util.Stack

class DrawingState {
    /** 所有页面，每页是一组笔触 */
    private val pages = mutableListOf(mutableListOf<Stroke>())
    private var currentPageIdx = 0
    private var currentStroke: Stroke? = null
    /** 每页独立的撤销栈 */
    private val undoTimelines = mutableListOf(Stack<List<Stroke>>())
    private val historyLimit = 50

    /** 每页独立的选中状态 */
    private val selectedStrokeIdsByPage = mutableMapOf(0 to mutableSetOf<String>())

    /** 当前页的笔触列表 */
    val strokes: MutableList<Stroke>
        get() = pages[currentPageIdx]

    val pageCount: Int get() = pages.size
    val currentPage: Int get() = currentPageIdx

    /** 当前页的撤销栈 */
    private val undoStack: Stack<List<Stroke>>
        get() = undoTimelines[currentPageIdx]

    /** 当前页的选中笔画 ID 集合 */
    @get:JvmName("currentPageSelectedIds")
    private val selectedStrokeIds: MutableSet<String>
        get() = selectedStrokeIdsByPage.getOrPut(currentPageIdx) { mutableSetOf() }

    fun getCurrentStroke(): Stroke? = currentStroke

    fun selectStrokes(ids: List<String>) {
        selectedStrokeIds.clear()
        selectedStrokeIds.addAll(ids)
    }

    fun clearSelection() {
        selectedStrokeIds.clear()
    }

    fun getSelectedStrokeIds(): MutableSet<String> = selectedStrokeIds

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
        selectedStrokeIds.clear()
    }

    fun undo(): Boolean {
        if (undoStack.isEmpty()) return false
        strokes.clear()
        strokes.addAll(undoStack.pop())
        currentStroke = null
        return true
    }

    // --- 翻页 ---

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

    fun goToPage(idx: Int): Boolean {
        if (idx < 0 || idx >= pages.size) return false
        currentPageIdx = idx
        currentStroke = null
        selectedStrokeIdsByPage.getOrPut(idx) { mutableSetOf() }
        return true
    }

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

    /** 计算当前页笔画边界框 */
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
                stroke.points.replaceAll { PointF(it.x + dx, it.y + dy, it.pressure) }
            }
        }
    }

    /** 重置所有进行中的操作状态 */
    fun resetInProgressOperations() {
        currentStroke = null
        clearSelection()
    }

    private fun pushUndoState() {
        val snapshot = strokes.map { stroke ->
            Stroke(stroke.id, stroke.color, stroke.width, stroke.points.toMutableList(), stroke.pressure)
        }
        undoStack.push(snapshot)
        if (undoStack.size > historyLimit) undoStack.removeAt(0)
    }
}
