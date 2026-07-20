package com.drawsync.app.data

import android.graphics.Color
import java.util.UUID

data class PointF(val x: Float, val y: Float, val pressure: Float = 0f)

data class Stroke(
    val id: String = UUID.randomUUID().toString(),
    val color: Int = Color.BLACK,
    val width: Float = 3f,
    val points: MutableList<PointF> = mutableListOf(),
    var pressure: Float = 0f
)
