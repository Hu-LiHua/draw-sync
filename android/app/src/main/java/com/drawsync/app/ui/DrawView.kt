package com.drawsync.app.ui

import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.widget.Toast
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
    var onLassoErase: ((List<PointF>) -> Unit)? = null
    var onLassoSelect: ((List<String>) -> Unit)? = null
    var onSelectionMove: ((Float, Float) -> Unit)? = null
    var onSelectionClear: (() -> Unit)? = null

    var toolMode: ToolMode = ToolMode.PEN
        set(value) {
            field = value
            resetLassoState()
            if (value != ToolMode.LASSO) {
                drawingState.clearSelection()
                drawingState.resetInProgressOperations()
            }
        }
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

    enum class ToolMode { PEN, ERASER_STROKE, ERASER_REGION, LASSO }

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

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val x = event.x
        val y = event.y
        val pressure = event.pressure

        when (toolMode) {
            ToolMode.PEN -> handlePenTouch(event, x, y, pressure)
            ToolMode.ERASER_STROKE -> handleEraserStrokeTouch(event, x, y)
            ToolMode.ERASER_REGION -> handleEraserRegionTouch(event, x, y)
            ToolMode.LASSO -> handleLassoTouch(event, x, y)
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
