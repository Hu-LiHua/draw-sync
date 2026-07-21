import { StrokeData, Point } from './protocol.js';

export class DrawingState {
  /** 所有页面，每页是一组笔画 */
  private pages: StrokeData[][] = [[]];
  private currentPageIdx = 0;
  private currentStroke: StrokeData | null = null;
  /** 每页独立的撤销栈 */
  private undoTimelines: Array<StrokeData[][]> = [[]];
  private historyLimit = 50;

  // --- 便捷 getter/setter，透明重定向到当前页 ---
  private get strokes(): StrokeData[] {
    return this.pages[this.currentPageIdx];
  }
  private set strokes(val: StrokeData[]) {
    this.pages[this.currentPageIdx] = val;
  }
  private get undoStack(): StrokeData[][] {
    return this.undoTimelines[this.currentPageIdx];
  }

  getCurrentStroke(): StrokeData | null { return this.currentStroke; }
  getAllStrokes(): StrokeData[] { return this.strokes; }
  getPageCount(): number { return this.pages.length; }
  getCurrentPageIdx(): number { return this.currentPageIdx; }

  // --- 笔画操作（与原来一致，通过 getter 操作当前页） ---

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

  // --- 翻页操作 ---

  /** 新建空白页（插入到当前页之后并跳转） */
  newPage(): void {
    this.pages.splice(this.currentPageIdx + 1, 0, []);
    this.undoTimelines.splice(this.currentPageIdx + 1, 0, []);
    this.currentPageIdx++;
    this.currentStroke = null;
  }

  /** 跳转到指定页 */
  goToPage(idx: number): boolean {
    if (idx < 0 || idx >= this.pages.length) return false;
    this.currentPageIdx = idx;
    this.currentStroke = null;
    return true;
  }

  /** 删除当前页，至少保留一页 */
  deleteCurrentPage(): boolean {
    if (this.pages.length <= 1) return false;
    this.pages.splice(this.currentPageIdx, 1);
    this.undoTimelines.splice(this.currentPageIdx, 1);
    if (this.currentPageIdx >= this.pages.length) {
      this.currentPageIdx = this.pages.length - 1;
    }
    this.currentStroke = null;
    return true;
  }

  // --- 辅助 ---

  /** 计算当前页所有笔画的内容边界框 */
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
