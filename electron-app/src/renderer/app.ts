import { DrawingState } from './data/DrawingState.js';
import { CanvasRenderer } from './components/CanvasRenderer.js';
import { WsMessage, ToolMode } from './data/protocol.js';

// --- 全局状态 ---
const drawingState = new DrawingState();
let toolMode: ToolMode = 'eraser-stroke';
let regionStart: { x: number; y: number } | null = null;

// --- 初始化 Canvas ---
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvas);

function resizeCanvas() {
  renderer.resize();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
}
window.addEventListener('resize', resizeCanvas);

// --- 连接状态 UI ---
function updateConnectionStatus(connected: boolean) {
  const el = document.getElementById('connection-status')!;
  const ipEl = document.getElementById('connection-ip')!;
  if (connected) {
    el.className = 'connected';
    el.textContent = '● 已连接';
    ipEl.textContent = localIP ? ` ${localIP}:8080` : '平板已连接';
  } else {
    el.className = 'disconnected';
    el.textContent = '● 未连接';
  }
}

// --- 收到本机 IP 后更新显示 ---
let localIP = '';
window.electronAPI.onLocalIp((ip: string) => {
  localIP = ip;
  const ipEl = document.getElementById('connection-ip')!;
  ipEl.textContent = `${ip}:8080 等待连接...`;
});

// --- 坐标缩放（Android 像素 → PC 画布） ---
let androidVw = 2560;
let androidVh = 1600;

function scalePoints(points: { x: number; y: number; pressure?: number }[]): { x: number; y: number; pressure?: number }[] {
  const sx = renderer.getWidth() / androidVw;
  const sy = renderer.getHeight() / androidVh;
  return points.map(p => ({ x: p.x * sx, y: p.y * sy, pressure: p.pressure }));
}

// --- 消息处理 ---
function handleMessage(msg: WsMessage) {
  switch (msg.type) {
    case 'stroke_start':
      androidVw = msg.vw || androidVw;
      androidVh = msg.vh || androidVh;
      drawingState.startStroke(msg.id, msg.color, msg.width, msg.pressure);
      setToolMode('eraser-stroke');
      break;
    case 'stroke_points':
      drawingState.addPoints(msg.id, scalePoints(msg.points));
      break;
    case 'stroke_end':
      drawingState.endStroke(msg.id);
      break;
    case 'eraser_stroke':
      drawingState.removeStroke(msg.targetId);
      setToolMode('eraser-stroke');
      break;
    case 'eraser_region_start': {
      const sx = renderer.getWidth() / androidVw;
      const sy = renderer.getHeight() / androidVh;
      regionStart = { x: msg.start.x * sx, y: msg.start.y * sy };
      setToolMode('eraser-stroke');
      break;
    }
    case 'eraser_region_end':
      if (regionStart) {
        const sx = renderer.getWidth() / androidVw;
        const sy = renderer.getHeight() / androidVh;
        drawingState.eraseRegion(regionStart, { x: msg.end.x * sx, y: msg.end.y * sy });
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
      break;
    case 'page_new':
      drawingState.newPage();
      updatePageIndicator();
      break;
    case 'page_go':
      drawingState.goToPage(msg.pageIdx);
      updatePageIndicator();
      break;
    case 'page_delete':
      drawingState.deleteCurrentPage();
      updatePageIndicator();
      break;
    case 'lasso_erase': {
      const points = scalePoints(msg.points);
      drawingState.eraseLassoRegion(points);
      break;
    }
    case 'lasso_select':
      drawingState.selectStrokes(msg.strokeIds);
      setToolMode('lasso');
      break;
    case 'selection_clear':
      drawingState.clearSelection();
      setToolMode('eraser-stroke');
      break;
    case 'selection_move': {
      const sx = renderer.getWidth() / androidVw;
      const sy = renderer.getHeight() / androidVh;
      drawingState.moveStrokes(
        [...drawingState.getSelectedStrokeIds()],
        msg.dx * sx,
        msg.dy * sy
      );
      break;
    }
  }
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
}

// --- 通过 IPC 回调接收主进程 WebSocket 消息和连接状态 ---
window.electronAPI.onConnectionStatus((connected: boolean) => {
  updateConnectionStatus(connected);
});

window.electronAPI.onDrawingMessage((msg: WsMessage) => {
  handleMessage(msg);
});

// --- 模式切换 ---
document.getElementById('mode-eraser-stroke')!.addEventListener('click', () => setToolMode('eraser-stroke'));
document.getElementById('mode-eraser-region')!.addEventListener('click', () => setToolMode('eraser-region'));
document.getElementById('mode-lasso')!.addEventListener('click', () => setToolMode('lasso'));

function setToolMode(mode: ToolMode) {
  toolMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  const idMap: Record<ToolMode, string> = {
    'eraser-stroke': 'mode-eraser-stroke',
    'eraser-region': 'mode-eraser-region',
    'lasso': 'mode-lasso',
  };
  document.getElementById(idMap[mode])!.classList.add('active');
}

// --- 撤销 / 清空 ---
document.getElementById('btn-undo')!.addEventListener('click', () => {
  drawingState.undo();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
});
document.getElementById('btn-clear')!.addEventListener('click', () => {
  drawingState.clear();
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
});

// --- 翻页 ---
function updatePageIndicator() {
  const idx = drawingState.getCurrentPageIdx();
  const total = drawingState.getPageCount();
  document.getElementById('page-indicator')!.textContent = `${idx + 1} / ${total}`;
  // 更新按钮禁用状态
  (document.getElementById('btn-page-prev') as HTMLButtonElement).disabled = idx === 0;
  (document.getElementById('btn-page-next') as HTMLButtonElement).disabled = idx === total - 1;
}

document.getElementById('btn-page-prev')!.addEventListener('click', () => {
  const newIdx = drawingState.getCurrentPageIdx() - 1;
  if (drawingState.goToPage(newIdx)) {
    window.electronAPI.sendToClient({ type: 'page_go', pageIdx: newIdx });
    renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
    updatePageIndicator();
  }
});

document.getElementById('btn-page-next')!.addEventListener('click', () => {
  const newIdx = drawingState.getCurrentPageIdx() + 1;
  if (drawingState.goToPage(newIdx)) {
    window.electronAPI.sendToClient({ type: 'page_go', pageIdx: newIdx });
    renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
    updatePageIndicator();
  }
});

document.getElementById('btn-page-new')!.addEventListener('click', () => {
  drawingState.newPage();
  window.electronAPI.sendToClient({ type: 'page_new' });
  renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
  updatePageIndicator();
});

document.getElementById('btn-page-delete')!.addEventListener('click', () => {
  if (drawingState.deleteCurrentPage()) {
    window.electronAPI.sendToClient({ type: 'page_delete' });
    renderer.render(drawingState.getAllStrokes(), drawingState.getCurrentStroke(), drawingState.getSelectedStrokeIds());
    updatePageIndicator();
  }
});

// --- 复制 ---
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
      window.electronAPI.copyToClipboard(reader.result as ArrayBuffer);
    };
    reader.readAsArrayBuffer(blob);
  }, 'image/png');
});

// --- 初始渲染 ---
resizeCanvas();
updatePageIndicator();

// --- 类型声明 ---
declare global {
  interface Window {
    electronAPI: {
      copyToClipboard: (data: ArrayBuffer) => void;
      saveToFile: () => void;
      sendToClient: (msg: any) => void;
      onDrawingMessage: (callback: (msg: any) => void) => void;
      onConnectionStatus: (callback: (connected: boolean) => void) => void;
      onLocalIp: (callback: (ip: string) => void) => void;
    };
  }
}
