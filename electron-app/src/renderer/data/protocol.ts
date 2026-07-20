// 通信协议消息类型定义

export interface Point {
  x: number;
  y: number;
  pressure?: number;
}

export interface StrokeData {
  id: string;
  color: string;
  width: number;
  points: Point[];
  pressure?: number;
}

export type WsMessage =
  | { type: 'stroke_start'; id: string; color: string; width: number; pressure?: number; vw: number; vh: number }
  | { type: 'stroke_points'; id: string; points: Point[] }
  | { type: 'stroke_end'; id: string }
  | { type: 'eraser_stroke'; targetId: string }
  | { type: 'eraser_region_start'; start: Point }
  | { type: 'eraser_region_end'; start: Point; end: Point }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'set_pen'; color: string; width: number };

export type ToolMode = 'pen' | 'eraser-stroke' | 'eraser-region';
