import { DrawingState } from './data/DrawingState';
import { CanvasRenderer } from './components/CanvasRenderer';
import { DrawSyncServer } from './network/WebSocketServer';
import { WsMessage, ToolMode } from './data/protocol';

// --- 全局状态 ---
const drawingState = new DrawingState();
let toolMode: ToolMode = 'pen';
let currentColor = '#000000';
let currentWidth = 3;
let regionStart: { x: number; y: number } | null = null;

// --- 初始化 Canvas ---
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas);

function resizeCanvas() {
  renderer.resize();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
}
window.addEventListener('resize', resizeCanvas);

// --- 初始化 WebSocket 服务端 ---
const server = new DrawSyncServer(
  (msg: WsMessage) => handleMessage(msg),
  (connected: boolean) => updateConnectionStatus(connected)
);
server.start(8080);

function updateConnectionStatus(connected: boolean) {
  const el = document.getElementById('connection-status')!;
  const ipEl = document.getElementById('connection-ip')!;
  if (connected) {
    el.className = 'connected';
    el.textContent = '● 已连接';
    ipEl.textContent = '平板已连接';
  } else {
    el.className = 'disconnected';
    el.textContent = '● 未连接';
    ipEl.textContent = '端口 8080 等待连接...';
  }
}

// --- 消息处理 ---
function handleMessage(msg: WsMessage) {
  switch (msg.type) {
    case 'stroke_start':
      drawingState.startStroke(msg.id, msg.color, msg.width, msg.pressure);
      break;
    case 'stroke_points':
      drawingState.addPoints(msg.id, msg.points);
      break;
    case 'stroke_end':
      drawingState.endStroke(msg.id);
      break;
    case 'eraser_stroke':
      drawingState.removeStroke(msg.targetId);
      break;
    case 'eraser_region_start':
      regionStart = msg.start;
      break;
    case 'eraser_region_end':
      if (regionStart) {
        drawingState.eraseRegion(regionStart, msg.end);
        regionStart = null;
      }
      break;
    case 'clear':
      drawingState.clear();
      break;
    case 'undo':
      drawingState.undo();
      break;
    case 'set_pen':
      break; // Android 发来的画笔设置仅通知
  }
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
}

// --- UI 交互 ---
// 颜色选择
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = (btn as HTMLElement).dataset.color!;
  });
});

// 粗细调整
const widthSlider = document.getElementById('width-slider') as HTMLInputElement;
widthSlider.addEventListener('input', () => { currentWidth = parseInt(widthSlider.value); });

// 模式切换
document.getElementById('mode-pen')!.addEventListener('click', () => setToolMode('pen'));
document.getElementById('mode-eraser-stroke')!.addEventListener('click', () => setToolMode('eraser-stroke'));
document.getElementById('mode-eraser-region')!.addEventListener('click', () => setToolMode('eraser-region'));

function setToolMode(mode: ToolMode) {
  toolMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  if (mode === 'pen') document.getElementById('mode-pen')!.classList.add('active');
  else if (mode === 'eraser-stroke') document.getElementById('mode-eraser-stroke')!.classList.add('active');
  else document.getElementById('mode-eraser-region')!.classList.add('active');
  canvas.style.cursor = mode === 'pen' ? 'crosshair' : 'pointer';
}

// 撤销/清空
document.getElementById('btn-undo')!.addEventListener('click', () => {
  drawingState.undo();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
});
document.getElementById('btn-clear')!.addEventListener('click', () => {
  drawingState.clear();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke());
});

// 复制/保存
document.getElementById('btn-copy')!.addEventListener('click', () => {
  const bbox = drawingState.getBoundingBox(20);
  if (!bbox) return;
  const strokes = drawingState.getAllStrokes();

  const offscreen = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  offscreen.width = bbox.width * dpr;
  offscreen.height = bbox.height * dpr;
  const offCtx = offscreen.getContext('2d')!;
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
  offCtx.scale(dpr, dpr);
  offCtx.translate(-bbox.x, -bbox.y);

  for (const s of strokes) {
    if (s.points.length < 1) continue;
    offCtx.beginPath();
    offCtx.strokeStyle = s.color;
    offCtx.lineWidth = s.width;
    offCtx.lineCap = 'round';
    offCtx.lineJoin = 'round';
    offCtx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) offCtx.lineTo(s.points[i].x, s.points[i].y);
    offCtx.stroke();
  }

  offscreen.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      // 通过 preload 调用主进程复制到剪贴板
      (window as any).electronAPI.copyToClipboard(reader.result);
    };
    reader.readAsArrayBuffer(blob);
  }, 'image/png');
});

// 初始渲染
resizeCanvas();

// --- 类型声明 ---
declare global {
  interface Window {
    electronAPI: {
      copyToClipboard: (data: ArrayBuffer) => void;
      saveToFile: () => void;
    };
  }
}
