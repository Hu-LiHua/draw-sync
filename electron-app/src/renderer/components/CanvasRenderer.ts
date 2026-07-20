import { StrokeData, Point, ToolMode } from '../data/protocol';

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.dpr = window.devicePixelRatio || 1;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
  }

  getWidth(): number { return this.canvas.getBoundingClientRect().width; }
  getHeight(): number { return this.canvas.getBoundingClientRect().height; }

  render(strokes: StrokeData[], currentStroke: StrokeData | null): void {
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;
    this.ctx.clearRect(0, 0, w, h);

    // 绘制背景
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, w, h);

    // 绘制所有已完成笔画
    for (const stroke of strokes) {
      this.drawStroke(stroke);
    }

    // 绘制当前正在画的笔触
    if (currentStroke) {
      this.drawStroke(currentStroke);
    }
  }

  private drawStroke(stroke: StrokeData): void {
    if (stroke.points.length < 1) return;

    this.ctx.beginPath();
    this.ctx.strokeStyle = stroke.color;
    this.ctx.lineWidth = stroke.width;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    // 第一个点作为 moveTo
    this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    // 中间点用 lineTo
    for (let i = 1; i < stroke.points.length; i++) {
      this.ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }

    this.ctx.stroke();
  }

  /** 导出内容区域为 PNG Buffer（裁剪到笔画边界） */
  exportContentClip(strokes: StrokeData[], bbox: { x: number; y: number; width: number; height: number } | null): Uint8Array | null {
    if (!bbox) return null;

    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;

    // 创建离屏 Canvas
    const offscreen = document.createElement('canvas');
    offscreen.width = bbox.width * this.dpr;
    offscreen.height = bbox.height * this.dpr;
    const offCtx = offscreen.getContext('2d')!;

    // 白色背景
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
    offCtx.scale(this.dpr, this.dpr);
    offCtx.translate(-bbox.x, -bbox.y);

    // 绘制笔画
    for (const stroke of strokes) {
      this.drawStrokeOnCtx(offCtx, stroke);
    }

    const blob = offscreen.toBlob((blob) => {
      if (blob) {
        blob.arrayBuffer().then(buf => {
          window.electronAPI?.copyToClipboard(buf);
        });
      }
    }, 'image/png');
    return null; // 实际通过 IPC 完成
  }

  private drawStrokeOnCtx(ctx: CanvasRenderingContext2D, stroke: StrokeData): void {
    if (stroke.points.length < 1) return;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }
}
