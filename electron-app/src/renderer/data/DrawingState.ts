import { StrokeData, Point } from './protocol.js';

export class DrawingState {
  strokes: StrokeData[] = [];
  private currentStroke: StrokeData | null = null;
  private undoStack: StrokeData[][] = [];
  private historyLimit = 50;

  getCurrentStroke(): StrokeData | null { return this.currentStroke; }
  getAllStrokes(): StrokeData[] { return this.strokes; }

  startStroke(id: string, color: string, width: number, pressure?: number): StrokeData {
    this.currentStroke = { id, color, width, points: [], pressure };
    return this.currentStroke;
  }

  addPoints(id: string, points: Point[]): boolean {
    if (!this.currentStroke || this.currentStroke.id !== id) return false;
    this.currentStroke.points.push(...points);
    return true;
  }

  endStroke(id: string): StrokeData | null {
    if (!this.currentStroke || this.currentStroke.id !== id) return null;
    const stroke = this.currentStroke;
    this.strokes.push(stroke);
    this.currentStroke = null;
    this.pushUndoState();
    return stroke;
  }

  removeStroke(targetId: string): StrokeData | null {
    const idx = this.strokes.findIndex(s => s.id === targetId);
    if (idx === -1) return null;
    const removed = this.strokes.splice(idx, 1)[0];
    this.pushUndoState();
    return removed;
  }

  /** 区域擦除：裁掉被矩形覆盖的坐标点 */
  eraseRegion(a: Point, b: Point): boolean {
    this.pushUndoState();
    const xMin = Math.min(a.x, b.x), xMax = Math.max(a.x, b.x);
    const yMin = Math.min(a.y, b.y), yMax = Math.max(a.y, b.y);
    let changed = false;

    for (const stroke of this.strokes) {
      const filtered = stroke.points.filter(p => p.x < xMin || p.x > xMax || p.y < yMin || p.y > yMax);
      if (filtered.length !== stroke.points.length) {
        stroke.points = filtered;
        changed = true;
      }
    }
    // 移除空笔触
    this.strokes = this.strokes.filter(s => s.points.length > 0);
    return changed;
  }

  clear(): void {
    this.pushUndoState();
    this.strokes = [];
    this.currentStroke = null;
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    this.strokes = this.undoStack.pop()!;
    this.currentStroke = null;
    return true;
  }

  /** 计算所有笔画的内容边界框（用于剪贴板裁剪） */
  getBoundingBox(padding = 20): { x: number; y: number; width: number; height: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasPoints = false;
    for (const s of this.strokes) {
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        hasPoints = true;
      }
    }
    if (!hasPoints) return null;
    return {
      x: Math.max(0, minX - padding),
      y: Math.max(0, minY - padding),
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }

  private pushUndoState(): void {
    this.undoStack.push(JSON.parse(JSON.stringify(this.strokes)));
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
  }
}
