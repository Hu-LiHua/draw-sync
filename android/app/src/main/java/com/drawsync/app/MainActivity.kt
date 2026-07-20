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
