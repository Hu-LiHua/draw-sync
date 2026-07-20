// DrawSync renderer process — skeleton UI wiring
// Full drawing logic will be implemented in subsequent tasks.

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const colorBtns = document.querySelectorAll('.color-btn');
const widthSlider = document.getElementById('width-slider') as HTMLInputElement;
const modePen = document.getElementById('mode-pen') as HTMLButtonElement;
const modeEraserStroke = document.getElementById('mode-eraser-stroke') as HTMLButtonElement;
const modeEraserRegion = document.getElementById('mode-eraser-region') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const connectionStatus = document.getElementById('connection-status') as HTMLSpanElement;

let currentColor = '#000000';
let currentWidth = 3;
let currentMode: 'pen' | 'eraser-stroke' | 'eraser-region' = 'pen';

// Resize canvas to fill container
function resizeCanvas(): void {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  // TODO: redraw existing content after resize in later tasks
}

window.addEventListener('resize', resizeCanvas);

// Color picker
colorBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    colorBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = (btn as HTMLButtonElement).dataset.color || '#000000';
  });
});

// Width slider
widthSlider.addEventListener('input', () => {
  currentWidth = parseInt(widthSlider.value, 10);
});

// Mode buttons
function setMode(mode: 'pen' | 'eraser-stroke' | 'eraser-region'): void {
  currentMode = mode;
  [modePen, modeEraserStroke, modeEraserRegion].forEach((b) => b.classList.remove('active'));
  if (mode === 'pen') modePen.classList.add('active');
  else if (mode === 'eraser-stroke') modeEraserStroke.classList.add('active');
  else modeEraserRegion.classList.add('active');
}

modePen.addEventListener('click', () => setMode('pen'));
modeEraserStroke.addEventListener('click', () => setMode('eraser-stroke'));
modeEraserRegion.addEventListener('click', () => setMode('eraser-region'));

// Undo / Clear (stubs)
btnUndo.addEventListener('click', () => {
  // TODO: implement undo stack
});

btnClear.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

// Copy / Save via preload bridge
btnCopy.addEventListener('click', async () => {
  try {
    await (window as any).electronAPI.copyToClipboard();
  } catch (e) {
    console.error('copyToClipboard failed', e);
  }
});

btnSave.addEventListener('click', async () => {
  try {
    await (window as any).electronAPI.saveToFile();
  } catch (e) {
    console.error('saveToFile failed', e);
  }
});

// Initial resize
resizeCanvas();
