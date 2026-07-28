import { StrokeData, Point } from './protocol.js';

export class DrawingState {
  /** 所有页面，每页是一组笔画 */
  private pages: StrokeData[][] = [[]];
  private currentPageIdx = 0;
  private currentStroke: StrokeData | null = null;
  /** 每页独立的撤销栈 */
  private undoTimelines: Array<StrokeData[][]> = [[]];
  private historyLimit = 50;
  /** 每页独立的选中状态 */
  private selectedStrokeIdsByPage: Map<number, Set<string>> = new Map();

  constructor() {
    this.selectedStrokeIdsByPage.set(0, new Set());
  }

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

  /** 当前页的选中笔画 ID 集合 */
  private get selectedStrokeIds(): Set<string> {
    if (!this.selectedStrokeIdsByPage.has(this.currentPageIdx)) {
      this.selectedStrokeIdsByPage.set(this.currentPageIdx, new Set());
    }
    return this.selectedStrokeIdsByPage.get(this.currentPageIdx)!;
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
    this.selectedStrokeIds.clear();
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    this.strokes = this.undoStack.pop()!;
    this.currentStroke = null;
    return true;
  }

  // --- 选中状态管理 ---

  selectStrokes(ids: string[]): void {
    this.selectedStrokeIds.clear();
    for (const id of ids) this.selectedStrokeIds.add(id);
  }

  clearSelection(): void {
    this.selectedStrokeIds.clear();
  }

  getSelectedStrokeIds(): Set<string> {
    return this.selectedStrokeIds;
  }

  // --- 多边形工具方法 ---

  /**
   * winding number 算法判断点是否在多边形内。
   * epsilon 1e-6 容差处理 ON_EDGE 情况。
   */
  pointInPolygon(point: Point, polygon: Point[]): boolean {
    const { x: px, y: py } = point;
    const n = polygon.length;
    let wn = 0;

    for (let i = 0; i < n; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];

      // 检查点是否在边上
      const cross = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
      if (Math.abs(cross) < 1e-6) {
        const dot = (px - p1.x) * (p2.x - p1.x) + (py - p1.y) * (p2.y - p1.y);
        if (dot >= 0) {
          const len2 = (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2;
          if (dot <= len2 + 1e-6) return true;
        }
      }

      if (p1.y <= py + 1e-6) {
        if (p2.y > py + 1e-6) {
          const isLeft = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
          if (isLeft > 0) wn++;
        }
      } else {
        if (p2.y <= py + 1e-6) {
          const isLeft = (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
          if (isLeft < 0) wn--;
        }
      }
    }
    return wn !== 0;
  }

  /** 返回至少有一个点落入套索多边形的笔画 ID 列表 */
  getStrokesInLasso(polygon: Point[]): string[] {
    const ids: string[] = [];
    for (const stroke of this.strokes) {
      for (const p of stroke.points) {
        if (this.pointInPolygon(p, polygon)) {
          ids.push(stroke.id);
          break;
        }
      }
    }
    return ids;
  }

  /** 套索区域擦除：裁剪落入多边形内的坐标点 */
  eraseLassoRegion(polygon: Point[]): boolean {
    if (polygon.length < 3) return false;
    this.pushUndoState();
    let changed = false;
    for (const stroke of this.strokes) {
      const filtered = stroke.points.filter(p => !this.pointInPolygon(p, polygon));
      if (filtered.length !== stroke.points.length) {
        stroke.points = filtered;
        changed = true;
      }
    }
    this.strokes = this.strokes.filter(s => s.points.length > 0);
    this.clearSelection();
    return changed;
  }

  /** 移动选中笔画 */
  moveStrokes(ids: string[], dx: number, dy: number): void {
    if (ids.length === 0) return;
    this.pushUndoState();
    const idSet = new Set(ids);
    for (const stroke of this.strokes) {
      if (idSet.has(stroke.id)) {
        for (const p of stroke.points) {
          p.x += dx;
          p.y += dy;
        }
      }
    }
  }

  /** 重置所有进行中的操作状态 */
  resetInProgressOperations(): void {
    this.currentStroke = null;
    this.clearSelection();
  }

  // --- 翻页操作 ---

  /** 新建空白页（插入到当前页之后并跳转） */
  newPage(): void {
    const insertIdx = this.currentPageIdx + 1;
    this.pages.splice(insertIdx, 0, []);
    this.undoTimelines.splice(insertIdx, 0, []);
    // 迁移选中状态索引
    const newSelMap = new Map<number, Set<string>>();
    for (const [pageIdx, selSet] of this.selectedStrokeIdsByPage.entries()) {
      newSelMap.set(pageIdx >= insertIdx ? pageIdx + 1 : pageIdx, selSet);
    }
    this.selectedStrokeIdsByPage = newSelMap;
    this.selectedStrokeIdsByPage.set(this.currentPageIdx + 1, new Set());
    this.currentPageIdx++;
    this.currentStroke = null;
  }

  /** 跳转到指定页 */
  goToPage(idx: number): boolean {
    if (idx < 0 || idx >= this.pages.length) return false;
    this.currentPageIdx = idx;
    this.currentStroke = null;
    if (!this.selectedStrokeIdsByPage.has(idx)) {
      this.selectedStrokeIdsByPage.set(idx, new Set());
    }
    return true;
  }

  /** 删除当前页，至少保留一页 */
  deleteCurrentPage(): boolean {
    if (this.pages.length <= 1) return false;
    const deletedIdx = this.currentPageIdx;
    this.pages.splice(deletedIdx, 1);
    this.undoTimelines.splice(deletedIdx, 1);
    if (this.currentPageIdx >= this.pages.length) {
      this.currentPageIdx = this.pages.length - 1;
    }
    this.selectedStrokeIdsByPage.delete(deletedIdx);
    const newSelMap = new Map<number, Set<string>>();
    for (const [pageIdx, selSet] of this.selectedStrokeIdsByPage.entries()) {
      newSelMap.set(pageIdx > deletedIdx ? pageIdx - 1 : pageIdx, selSet);
    }
    this.selectedStrokeIdsByPage = newSelMap;
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
