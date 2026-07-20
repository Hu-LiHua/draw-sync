import { StrokeData } from '../data/protocol';

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

    this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    for (let i = 1; i < stroke.points.length; i++) {
      this.ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }

    this.ctx.stroke();
  }
}
