// main.js — wire the Viewer to the DOM controls, status line, and URL hash.
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const viewer = new Viewer(canvas, {
  onStatus: updateStatus,
  onView: (s) => { updateView(s); scheduleHash(); },
});

// expose for tests / debugging
window.__viewer = viewer;

// ---------- status / readouts ----------
function updateStatus(s) {
  const el = $('status');
  if (s.error) { el.textContent = '⚠ ' + s.error.split('\n')[0]; return; }
  if (s.phase === 'start') el.textContent = `rendering · ${s.engine} · ${s.maxIter} it`;
  else if (s.phase === 'reference') el.textContent = `reference orbit ${pct(s.i, s.total)}`;
  else if (s.phase === 'render') el.textContent = `rendering ${pct(s.i, s.total)}`;
  else if (s.phase === 'done') {
    el.textContent = `${s.engine} · done${s.glitches ? ' · ' + s.glitches + ' glitch?' : ''}`;
    $('debug').textContent = debugText(s);
    window.__lastDone = s;
    window.__doneCount = (window.__doneCount || 0) + 1; // test sync signal
  }
}
function pct(i, t) { return t ? Math.min(100, Math.round((i / t) * 100)) + '%' : ''; }
function debugText(s) {
  const v = viewer.getState();
  const gpu = viewer.gpuInfo();
  return [
    `engine     ${s.engine}`,
    `gpu        ${gpu ? gpu.replace(/^ANGLE \(/, '').slice(0, 48) : 'off (CPU workers)'}`,
    `zoom       2^${v.zoom.toFixed(2)}  (radius ${v.radius.toExponential(3)})`,
    `maxIter    ${v.maxIter}`,
    `supersample ${viewer._effSS}×  (compute ${viewer.cW}×${viewer.cH})`,
    `precision  ${viewer.prec} bits`,
    `refLen     ${s.refLen}  relocations ${s.relocations}`,
    `glitches   ${s.glitches}`,
    `backing    ${viewer.backingW}×${viewer.backingH} @dpr${viewer.dpr.toFixed(2)}`,
  ].join('\n');
}
function updateView(s) {
  $('zoom').textContent = '2^' + s.zoom.toFixed(1);
  if (document.activeElement !== $('reIn')) $('reIn').value = s.cx;
  if (document.activeElement !== $('imIn')) $('imIn').value = s.cy;
  if (document.activeElement !== $('radIn')) $('radIn').value = s.radius.toExponential(6);
  setIterUI(s.maxIter);
}

// Keep the iteration slider + number field in sync with the current maxIter,
// without clobbering whichever control the user is actively editing. The slider
// is clamped to its track; the number field shows the true value (can exceed it).
function setIterUI(v) {
  const slider = $('iter'), num = $('iterNum');
  if (document.activeElement !== slider) {
    slider.value = Math.min(+slider.max, Math.max(+slider.min, v));
  }
  if (document.activeElement !== num) num.value = v;
}

// ---------- URL hash (bookmarks / shareable deep coords) ----------
let hashTimer = 0;
function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 400); }
function writeHash() {
  const s = viewer.getState();
  const p = new URLSearchParams();
  p.set('re', s.cx); p.set('im', s.cy); p.set('r', s.radius.toExponential(8));
  p.set('i', s.maxIter); p.set('p', viewer.paletteOpts.paletteId);
  p.set('cy', viewer.paletteOpts.cycle); p.set('sh', viewer.paletteOpts.shift);
  p.set('ss', viewer.ss);
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() {
  if (!location.hash || location.hash.length < 2) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get('re')) return false;
  if (p.get('p')) viewer.paletteOpts.paletteId = p.get('p');
  if (p.get('cy')) viewer.paletteOpts.cycle = +p.get('cy');
  if (p.get('sh')) viewer.paletteOpts.shift = +p.get('sh');
  if (p.get('ss')) viewer.ss = Math.max(1, Math.min(4, +p.get('ss')));
  viewer.setState({ cx: p.get('re'), cy: p.get('im'), radius: +p.get('r'), maxIter: p.get('i') ? +p.get('i') : undefined });
  if (p.get('i')) { viewer.autoIter = false; $('autoIter').checked = false; }
  syncControls();
  return true;
}

// ---------- controls ----------
function syncControls() {
  $('palette').value = viewer.paletteOpts.paletteId;
  $('cycle').value = viewer.paletteOpts.cycle;
  $('shift').value = viewer.paletteOpts.shift;
  $('cycleVal').textContent = viewer.paletteOpts.cycle;
  $('autoIter').checked = viewer.autoIter;
  $('ss').value = String(viewer.ss);
}

$('panelToggle').addEventListener('click', () => $('panel').classList.toggle('open'));
$('panelClose').addEventListener('click', () => $('panel').classList.remove('open'));

$('zoomIn').addEventListener('click', () => viewer.zoomBy(0.5));
$('zoomOut').addEventListener('click', () => viewer.zoomBy(2));
$('reset').addEventListener('click', () => {
  viewer.setState({ cx: '-0.5', cy: '0', radius: 1.5 });
  viewer.autoIter = true; $('autoIter').checked = true;
});

// Iterations: slider for quick scrubbing, number field for precise/large values.
// Both commit on `change` (slider release / Enter / blur); `input` just mirrors
// the live value to the sibling control so they always agree, without rendering.
function commitIter(v) {
  if (!isFinite(v) || v < 1) return;
  viewer.setMaxIter(Math.round(v)); // sets autoIter=false + re-renders
  $('autoIter').checked = false;
}
$('iter').addEventListener('input', (e) => { $('iterNum').value = e.target.value; });
$('iter').addEventListener('change', (e) => commitIter(+e.target.value));
$('iterNum').addEventListener('input', (e) => {
  const v = +e.target.value;
  if (isFinite(v) && v > 0) $('iter').value = Math.min(+$('iter').max, Math.max(+$('iter').min, v));
});
$('iterNum').addEventListener('change', (e) => commitIter(+e.target.value));
$('autoIter').addEventListener('change', (e) => viewer.setAutoIter(e.target.checked));
$('useGpu').addEventListener('change', (e) => viewer.setUseGpu(e.target.checked));
$('ss').addEventListener('change', (e) => { viewer.setSupersample(+e.target.value); scheduleHash(); });

$('palette').addEventListener('change', (e) => { viewer.setPalette({ paletteId: e.target.value }); scheduleHash(); });
$('cycle').addEventListener('input', (e) => { $('cycleVal').textContent = e.target.value; viewer.setPalette({ cycle: +e.target.value }); scheduleHash(); });
$('shift').addEventListener('input', (e) => { viewer.setPalette({ shift: +e.target.value }); scheduleHash(); });

$('goto').addEventListener('click', () => {
  const re = $('reIn').value.trim(), im = $('imIn').value.trim();
  let r = parseFloat($('radIn').value.trim());
  if (!isFinite(r) || r <= 0) r = viewer.radius;
  viewer.setState({ cx: re, cy: im, radius: r });
  $('panel').classList.remove('open');
});
$('copyLink').addEventListener('click', async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); $('status').textContent = 'link copied'; }
  catch { $('status').textContent = location.href; }
});
$('save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = `mandelbrot_2e${viewer.zoomLevel().toFixed(0)}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
});

document.querySelectorAll('.place').forEach((b) => b.addEventListener('click', () => {
  viewer.setState({ cx: b.dataset.cx, cy: b.dataset.cy, radius: parseFloat(b.dataset.r) });
  $('panel').classList.remove('open');
}));

// ---------- boot ----------
syncControls();
setIterUI(viewer.maxIter);
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => viewer.resize(), 150); });
// initial size + render (after layout), then apply any bookmarked hash
requestAnimationFrame(() => {
  viewer.resize();   // sizes the canvas and renders the default view
  readHash();        // if a deep-zoom link is present, override and re-render
});
window.addEventListener('hashchange', () => readHash());
