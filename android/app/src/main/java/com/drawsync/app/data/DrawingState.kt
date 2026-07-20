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
