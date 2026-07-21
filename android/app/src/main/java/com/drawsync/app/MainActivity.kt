package com.drawsync.app

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.children
import com.drawsync.app.network.WebSocketClient
import com.drawsync.app.ui.DrawView

class MainActivity : AppCompatActivity() {

    private lateinit var drawView: DrawView
    private lateinit var connectionBar: LinearLayout
    private lateinit var pageBar: LinearLayout
    private lateinit var toolbar: LinearLayout
    private lateinit var connectionStatus: TextView
    private lateinit var ipInput: EditText
    private lateinit var connectBtn: Button
    private lateinit var widthSlider: SeekBar
    private lateinit var modePen: ToggleButton
    private lateinit var modeEraserStroke: ToggleButton
    private lateinit var modeEraserRegion: ToggleButton
    private lateinit var pageIndicator: TextView
    private lateinit var btnPagePrev: Button
    private lateinit var btnPageNext: Button

    private var webSocket: WebSocketClient? = null
    private var focusMode = false
    private lateinit var btnExitFocus: Button

    private val colorButtons = listOf(
        0xFF000000.toInt(), 0xFFFF0000.toInt(), 0xFF0000FF.toInt(),
        0xFF00AA00.toInt(), 0xFFFF8800.toInt(), 0xFF8800FF.toInt()
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        initViews()
        setupToolbar()
        setupPageNav()
        setupFocusMode()
        setupWebSocket()
    }

    private fun initViews() {
        drawView = findViewById(R.id.drawView)
        connectionBar = findViewById(R.id.connectionBar)
        pageBar = findViewById(R.id.pageBar)
        toolbar = findViewById(R.id.toolbar)
        connectionStatus = findViewById(R.id.connectionStatus)
        ipInput = findViewById(R.id.ipInput)
        connectBtn = findViewById(R.id.connectBtn)
        widthSlider = findViewById(R.id.widthSlider)
        modePen = findViewById(R.id.modePen)
        modeEraserStroke = findViewById(R.id.modeEraserStroke)
        modeEraserRegion = findViewById(R.id.modeEraserRegion)
        pageIndicator = findViewById(R.id.pageIndicator)
        btnPagePrev = findViewById(R.id.btnPagePrev)
        btnPageNext = findViewById(R.id.btnPageNext)

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

    // --- 翻页 ---
    private fun setupPageNav() {
        findViewById<Button>(R.id.btnPagePrev).setOnClickListener {
            val ds = drawView.drawingState
            if (ds.goToPage(ds.currentPage - 1)) {
                webSocket?.sendPageGo(ds.currentPage)
                drawView.invalidate()
                updatePageIndicator()
            }
        }

        findViewById<Button>(R.id.btnPageNext).setOnClickListener {
            val ds = drawView.drawingState
            if (ds.goToPage(ds.currentPage + 1)) {
                webSocket?.sendPageGo(ds.currentPage)
                drawView.invalidate()
                updatePageIndicator()
            }
        }

        findViewById<Button>(R.id.btnPageNew).setOnClickListener {
            val ds = drawView.drawingState
            ds.newPage()
            webSocket?.sendPageNew()
            drawView.invalidate()
            updatePageIndicator()
        }

        findViewById<Button>(R.id.btnPageDelete).setOnClickListener {
            val ds = drawView.drawingState
            if (ds.deleteCurrentPage()) {
                webSocket?.sendPageDelete()
                drawView.invalidate()
                updatePageIndicator()
            }
        }

        updatePageIndicator()
    }

    private fun updatePageIndicator() {
        val ds = drawView.drawingState
        pageIndicator.text = "${ds.currentPage + 1} / ${ds.pageCount}"
        btnPagePrev.isEnabled = ds.currentPage > 0
        btnPageNext.isEnabled = ds.currentPage < ds.pageCount - 1
    }

    // --- 专注模式 ---
    private fun setupFocusMode() {
        // 创建悬浮退出按钮，添加到 decorView
        btnExitFocus = Button(this).apply {
            text = "✕ 退出专注"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 13f
            setBackgroundColor(0x99000000.toInt())
            visibility = View.GONE
            setOnClickListener { exitFocusMode() }
        }

        // 点击专注按钮切换
        findViewById<Button>(R.id.btnFocus).setOnClickListener {
            if (focusMode) exitFocusMode() else enterFocusMode()
        }
    }

    private fun enterFocusMode() {
        focusMode = true
        connectionBar.visibility = View.GONE
        pageBar.visibility = View.GONE
        toolbar.visibility = View.GONE

        // 将退出按钮添加到 window 顶层
        if (btnExitFocus.parent == null) {
            val params = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.END
            ).apply {
                topMargin = 12.dp
                rightMargin = 12.dp
            }
            (window.decorView as FrameLayout).addView(btnExitFocus, params)
        }
        btnExitFocus.visibility = View.VISIBLE

        // 沉浸式全屏：隐藏状态栏 + 导航栏
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    private fun exitFocusMode() {
        focusMode = false
        connectionBar.visibility = View.VISIBLE
        pageBar.visibility = View.VISIBLE
        toolbar.visibility = View.VISIBLE
        btnExitFocus.visibility = View.GONE

        // 恢复系统 UI
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
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
            },
            onPageCommand = { type, pageIdx ->
                val ds = drawView.drawingState
                when (type) {
                    "page_new" -> {
                        ds.newPage()
                        drawView.invalidate()
                        updatePageIndicator()
                    }
                    "page_go" -> {
                        if (pageIdx != null && ds.goToPage(pageIdx)) {
                            drawView.invalidate()
                            updatePageIndicator()
                        }
                    }
                    "page_delete" -> {
                        if (ds.deleteCurrentPage()) {
                            drawView.invalidate()
                            updatePageIndicator()
                        }
                    }
                }
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
            webSocket?.sendStrokeStart(stroke, drawView.width, drawView.height)
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
        // 清理悬浮按钮
        if (btnExitFocus.parent != null) {
            (btnExitFocus.parent as ViewGroup).removeView(btnExitFocus)
        }
        super.onDestroy()
    }

    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()
}
