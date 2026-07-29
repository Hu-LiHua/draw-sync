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
    private val onError: (String) -> Unit,
    private val onPageCommand: ((type: String, pageIdx: Int?) -> Unit)? = null
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
                // 处理 PC 端发来的翻页同步消息
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "page_new" -> mainHandler.post { onPageCommand?.invoke("page_new", null) }
                        "page_go" -> {
                            val idx = json.optInt("pageIdx", -1)
                            if (idx >= 0) mainHandler.post { onPageCommand?.invoke("page_go", idx) }
                        }
                        "page_delete" -> mainHandler.post { onPageCommand?.invoke("page_delete", null) }
                        "selection_clear" -> {
                            // PC→Android 扩展点：当前 Android 端不处理反向 selection_clear
                        }
                    }
                } catch (_: Exception) { }
            }
        })
    }

    fun disconnect() {
        webSocket?.close(1000, "用户断开")
        webSocket = null
    }

    fun isConnected(): Boolean = webSocket != null

    // --- 发送消息 ---

    fun sendStrokeStart(stroke: Stroke, vw: Int, vh: Int) {
        val json = JSONObject().apply {
            put("type", "stroke_start")
            put("id", stroke.id)
            put("color", String.format("#%06X", 0xFFFFFF and stroke.color))
            put("width", stroke.width.toDouble())
            put("vw", vw)
            put("vh", vh)
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

    fun sendPageNew() {
        webSocket?.send(JSONObject().apply { put("type", "page_new") }.toString())
    }

    fun sendPageGo(pageIdx: Int) {
        val json = JSONObject().apply {
            put("type", "page_go")
            put("pageIdx", pageIdx)
        }
        webSocket?.send(json.toString())
    }

    fun sendPageDelete() {
        webSocket?.send(JSONObject().apply { put("type", "page_delete") }.toString())
    }

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
}
