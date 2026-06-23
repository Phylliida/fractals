// viewer.js — canvas + high-precision view state + gestures + progressive render.
//
// View state:
//   cx, cy : BigInt fixed-point center at precision `prec`
//   radius : double, half-height of the view in the complex plane
//   maxIter
// Gestures manipulate a preview transform of the last stable image (instant
// feedback); on gesture end the transform is folded into the view state and a
// real render is kicked off in the worker.

import {
  fromDecimalString, toDecimalString, fromDouble, toDouble, precForRadius,
} from './math/bignum.js';
import { engineForRadius, autoMaxIter, gpuEngineForRadius } from './math/render.js';
import { colorizeBlocks, colorizeRegion, paletteRgbAt } from './palette.js';
import { GpuRenderer } from './gpu/renderer.js';

const GUARD_BITS = 80;
const MAX_BACKING = 1100;     // cap *display* resolution for mobile perf
// Supersampling caps: the fractal is computed at ss× the display res then box-
// averaged down. ss² multiplies pixel work and (GPU) the float sn-texture size,
// so bound both the longest edge and the total compute pixels (sn tex bytes =
// 16 * pixels) to stay within mobile GPU memory / sane CPU time.
const MAX_COMPUTE_DIM = 8192;
const MAX_COMPUTE_PIXELS = 12e6;

export class Viewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.stable = document.createElement('canvas'); // last completed render
    this.sctx = this.stable.getContext('2d', { alpha: false });

    // view state
    this.prec = precForRadius(1.5, GUARD_BITS);
    this.cx = fromDecimalString('-0.5', this.prec);
    this.cy = fromDecimalString('0', this.prec);
    this.radius = 1.5;
    this.maxIter = autoMaxIter(this.radius);
    this.autoIter = true;

    // coloring
    this.paletteOpts = { paletteId: 'ultra', cycle: 48, shift: 0, interior: [0, 0, 0] };

    // supersampling: render the fractal at ss× the display res, box-average the
    // colors down. Anti-aliases the boundary filaments (the "ultra" smooth look).
    // GPU averages in the color shader; CPU renders to an offscreen compute canvas
    // and downscale-blits. ss=1 = off (and the fast direct-to-display CPU path).
    this.ss = Math.max(1, Math.round(opts.ss || 2));
    this._effSS = 1;            // ss after the compute-size caps (set per render)
    this.cW = 0; this.cH = 0;   // compute resolution = _effSS × backing
    this._compute = document.createElement('canvas'); // offscreen compute target (CPU, ss>1)
    this._cctx = this._compute.getContext('2d', { alpha: false });
    this._paintCtx = this.ctx;  // where bands putImageData (display ctx, or compute ctx)
    this._presentRAF = 0;

    // GPU renderer (lazy; null if unsupported or disabled). The per-pixel raster
    // runs in WebGL shaders; the high-precision reference orbit is still computed
    // on the CPU worker and uploaded as a texture. CPU pool is the fallback/oracle.
    this.gpu = null;
    this._gpuChecked = false;
    this._gpuPaletteId = null;
    this._lastGpu = false;
    this.forceCpu = !!opts.forceCpu;   // tests / fallback can pin the CPU path
    this._mode = 'cpu';

    // render plumbing (worker pool)
    this._pool = [];
    this.poolSize = Math.max(1, Math.min(opts.poolSize || (navigator.hardwareConcurrency || 4), 12));
    this.bandRows = 16;
    this.gen = 0;
    this.img = null;          // ImageData of current render
    this.dpr = 1;
    this.backingW = 0; this.backingH = 0;
    this.rendering = false;
    this._tilesLeft = 0;
    this._glitchAcc = 0;
    this._refMeta = null;
    this.onStatus = opts.onStatus || (() => {});
    this.onView = opts.onView || (() => {});

    // gesture transform (backing-pixel space): displayed = a*orig + (e,f)
    this.T = null;
    this._pointers = new Map();
    this._pinch = null;
    this._settleTimer = 0;   // debounce: real render fires once zoom motion stops

    this._installGestures();
  }

  // ---- sizing ----
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(rect.width * dpr);
    let h = Math.round(rect.height * dpr);
    // cap backing resolution
    const scale = Math.min(1, MAX_BACKING / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    this.dpr = dpr * scale;
    this.backingW = w; this.backingH = h;
    this.canvas.width = w; this.canvas.height = h;
    this.stable.width = w; this.stable.height = h;
    this.cssW = rect.width; this.cssH = rect.height;
    this.render();
  }

  // CSS pointer coords -> backing pixel coords
  _toBacking(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width * this.backingW,
      y: (clientY - rect.top) / rect.height * this.backingH,
    };
  }

  // complex offset (double) of a backing pixel from the view center
  _pixelDelta(px, py) {
    const aspect = this.backingW / this.backingH;
    const scale = (2 * this.radius) / this.backingH;
    return { dx: -this.radius * aspect + px * scale, dy: -this.radius + py * scale };
  }

  _setPrec(newPrec) {
    if (newPrec === this.prec) return;
    if (newPrec > this.prec) {
      const s = BigInt(newPrec - this.prec);
      this.cx <<= s; this.cy <<= s;
    } else {
      const s = BigInt(this.prec - newPrec);
      this.cx >>= s; this.cy >>= s;
    }
    this.prec = newPrec;
  }

  // ---- view operations ----
  zoomAt(px, py, factor) {
    // keep the complex point under (px,py) fixed while radius *= factor
    const { dx, dy } = this._pixelDelta(px, py);
    this.cx += fromDouble(dx * (1 - factor), this.prec);
    this.cy += fromDouble(dy * (1 - factor), this.prec);
    this.radius *= factor;
    this._afterRadiusChange();
  }

  panBacking(dxPix, dyPix) {
    const scale = (2 * this.radius) / this.backingH;
    this.cx -= fromDouble(dxPix * scale, this.prec);
    this.cy -= fromDouble(dyPix * scale, this.prec);
  }

  _afterRadiusChange() {
    const want = precForRadius(this.radius, GUARD_BITS);
    if (want > this.prec) this._setPrec(want);
    if (this.autoIter) this.maxIter = autoMaxIter(this.radius);
  }

  zoomLevel() { return Math.log2(1.5 / this.radius); }

  getState() {
    return {
      cx: toDecimalString(this.cx, this.prec, Math.ceil(this.prec / 3.32) + 5),
      cy: toDecimalString(this.cy, this.prec, Math.ceil(this.prec / 3.32) + 5),
      radius: this.radius,
      maxIter: this.maxIter,
      zoom: this.zoomLevel(),
    };
  }

  setState(s) {
    if (s.radius) this.radius = +s.radius;
    this.prec = precForRadius(this.radius, GUARD_BITS);
    if (s.cx != null) this.cx = fromDecimalString(String(s.cx), this.prec);
    if (s.cy != null) this.cy = fromDecimalString(String(s.cy), this.prec);
    if (s.maxIter) { this.maxIter = +s.maxIter; this.autoIter = false; }
    else if (this.autoIter) this.maxIter = autoMaxIter(this.radius);
    this.render();
  }

  // Toggle the GPU path. Turning it on re-probes WebGL support; off pins the CPU
  // worker engines (the validated oracle/fallback). Either way, re-render.
  setUseGpu(on) {
    this.forceCpu = !on;
    this._gpuChecked = false;
    if (this.gpu && !on) { try { this.gpu.dispose(); } catch { /* noop */ } }
    this.gpu = null;
    this.render();
  }

  // For the debug readout: which GPU is active (null if CPU path).
  gpuInfo() {
    if (!this.gpu || !this.gpu.gl) return null;
    const gl = this.gpu.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
  }

  // Set the supersample factor (1 = off). Re-renders at the new compute res.
  setSupersample(n) {
    const s = Math.max(1, Math.min(4, Math.round(+n || 1)));
    if (s === this.ss) return;
    this.ss = s;
    this.render();
  }

  setMaxIter(v) { this.maxIter = v; this.autoIter = false; this.render(); }
  setAutoIter(on) { this.autoIter = on; if (on) { this.maxIter = autoMaxIter(this.radius); this.render(); } }
  setPalette(opts) {
    Object.assign(this.paletteOpts, opts);
    // recolor instantly without recomputing the fractal
    if (this._lastGpu && this.gpu && !this.rendering) this._recolorGpu();
    else if (this.img && this._sn && !this._lastGpu) this._recolor();
    else this.render();
  }

  // ---- rendering (worker pool) ----
  _terminatePool() {
    for (const w of this._pool) { try { w.terminate(); } catch { /* noop */ } }
    this._pool = [];
  }

  _spawnPool(n) {
    this._terminatePool();
    const count = n || this.poolSize;
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const gen = this.gen;
      w.onmessage = (e) => this._onWorker(e.data, gen);
      w.onerror = (err) => this.onStatus({ error: String(err.message || err) });
      this._pool.push(w);
    }
  }

  // Effective supersample factor after the memory/size caps, given the display res.
  _effectiveSS() {
    let s = Math.max(1, Math.round(this.ss || 1));
    const maxDim = Math.max(this.backingW, this.backingH, 1);
    while (s > 1 && (maxDim * s > MAX_COMPUTE_DIM ||
                     this.backingW * s * this.backingH * s > MAX_COMPUTE_PIXELS)) {
      s--;
    }
    return s;
  }

  // Recompute compute resolution + the CPU paint target for the current ss.
  // ss==1: paint straight to the display canvas (fast path, no extra blit).
  // ss>1 : paint to an offscreen compute canvas, downscale-blit on present().
  _updateComputeSize() {
    this._effSS = this._effectiveSS();
    this.cW = this.backingW * this._effSS;
    this.cH = this.backingH * this._effSS;
    if (this._effSS > 1) {
      if (this._compute.width !== this.cW || this._compute.height !== this.cH) {
        this._compute.width = this.cW; this._compute.height = this.cH;
      }
      this._paintCtx = this._cctx;   // CPU bands paint into the offscreen compute canvas
    } else {
      this._paintCtx = this.ctx;     // ss==1: paint straight to the display canvas
    }
  }

  // Downscale the compute canvas onto the display canvas (the supersample average).
  // Smoothing ON here (area/box filter = the AA); the display->screen upscale stays
  // point-filtered (CSS image-rendering: pixelated) for crispness. No-op at ss==1.
  _presentNow() {
    if (this._effSS <= 1) return;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this._compute, 0, 0, this.cW, this.cH, 0, 0, this.backingW, this.backingH);
  }
  _schedulePresent() {
    if (this._effSS <= 1 || this._presentRAF) return;
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    this._presentRAF = raf(() => { this._presentRAF = 0; this._presentNow(); });
  }
  _clearPresent() {
    if (this._presentRAF && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._presentRAF);
    this._presentRAF = 0;
  }

  render() {
    if (!this.backingW) return;
    this._clearSettle();
    this._clearPresent();
    this._updateComputeSize();
    this.gen++;
    this.T = null; // clear preview transform; we render fresh
    this.rendering = true;
    this._glitchAcc = 0;
    this._refMeta = null;
    this.onView(this.getState());

    // Pick the GPU engine if available + in range; else fall back to CPU workers.
    const gpuEngine = this._ensureGpu() ? gpuEngineForRadius(this.radius) : null;
    if (gpuEngine === 'naive') { this._mode = 'gpu-naive'; this._renderGpuNaive(); return; }
    if (gpuEngine === 'perturb' || gpuEngine === 'perturb-fe') {
      this._mode = gpuEngine === 'perturb-fe' ? 'gpu-perturb-fe' : 'gpu-perturb';
      this._startGpuPerturb(); return;
    }

    // ---- CPU path (worker pool) ----
    this._mode = 'cpu';
    this._lastGpu = false;
    this.img = this.ctx.createImageData(this.cW, this.cH);     // at compute res
    this._sn = new Float64Array(this.cW * this.cH);            // compute-res sn cache
    this._sn.fill(-2); // -2 = not yet computed
    // Bands aligned to the supersample factor so each band maps to whole display
    // rows on present (no partial-block downscale seams).
    this.bandRows = Math.max(this._effSS, Math.round(16 / this._effSS) * this._effSS);
    const engine = engineForRadius(this.radius);
    this._spawnPool();
    // worker[0] computes the reference (or naive params) + a coarse pass
    this._pool[0].postMessage({
      type: 'computeRef', gen: this.gen,
      cxRaw: this.cx.toString(), cyRaw: this.cy.toString(), prec: this.prec,
      radius: this.radius, width: this.cW, height: this.cH,
      maxIter: this.maxIter, engine, wantCoarse: true,
    });
    this.onStatus({ phase: 'start', engine, maxIter: this.maxIter, zoom: this.zoomLevel() });
  }

  // ---- GPU rendering ----
  _ensureGpu() {
    if (this._gpuChecked) return !!this.gpu;
    this._gpuChecked = true;
    if (this.forceCpu) { this.gpu = null; return false; }
    try {
      const g = new GpuRenderer({ width: this.backingW || 1, height: this.backingH || 1 });
      this.gpu = g.supported ? g : null;
      this._gpuPaletteId = null;
    } catch (e) { this.gpu = null; }
    return !!this.gpu;
  }

  _setGpuLUT() {
    const pid = this.paletteOpts.paletteId;
    if (this._gpuPaletteId === pid) return;
    this.gpu.setPaletteLUT((u) => paletteRgbAt(pid, u), 1024);
    this._gpuPaletteId = pid;
  }

  _gpuColorOpts() {
    return { cycle: this.paletteOpts.cycle, shift: this.paletteOpts.shift,
             interior: this.paletteOpts.interior || [0, 0, 0], ss: this._effSS };
  }

  // The GPU color pass already supersampled (averaged) down to the display res,
  // so its canvas is 1:1 with ours — point-copy it (no smoothing).
  _blitGpu() { this.ctx.imageSmoothingEnabled = false; this.ctx.drawImage(this.gpu.canvas, 0, 0); }

  _finishGpu(engine, glitches) {
    this.rendering = false;
    this._lastGpu = true;
    this.sctx.drawImage(this.canvas, 0, 0); // snapshot for gesture previews
    const meta = this._refMeta || {};
    this.onStatus({ phase: 'done', engine, glitches, refLen: meta.refLen || 0,
                    relocations: meta.relocations || 0, zoom: this.zoomLevel() });
  }

  _gpuFail(e) {
    // Disable GPU for the session and re-render this view on the CPU workers.
    // eslint-disable-next-line no-console
    console.warn('GPU render failed; falling back to CPU:', e && (e.message || e));
    this.gpu = null; this._lastGpu = false;
    this.render();
  }

  _raf() { return new Promise((r) => requestAnimationFrame(r)); }

  // Strip height (compute rows per GPU escape draw), aligned to the supersample
  // factor so each strip maps to whole display rows. Sized so one strip's worst-case
  // work (rows × width × maxIter pixel-iterations) stays well under a GPU watchdog
  // (~2s) even on a modest mobile GPU, while keeping the strip count (per-strip
  // overhead) reasonable. Cheap/shallow views collapse to a single full-frame strip.
  _stripRows() {
    const W = Math.max(1, this.cW), ss = this._effSS;
    const budget = 4e8;                         // pixel-iterations per strip (watchdog headroom)
    let rows = Math.floor(budget / (W * Math.max(1, this.maxIter)));
    rows = Math.max(ss, Math.round(rows / ss) * ss);   // >= ss, aligned to ss
    return Math.min(rows, this.cH);
  }

  // Run a GPU escape pass in horizontal strips, yielding a frame between draws. This
  // is the fix for "can't zoom past ~2^218": a deep frame needs maxIter ~55k, and a
  // SINGLE full-screen draw at that count runs long enough to trip the GPU watchdog
  // (TDR) on real hardware → context loss → CPU fallback (minutes). Splitting it into
  // short per-strip draws keeps every draw under the watchdog, lets the page stay
  // responsive, and reveals the image top-to-bottom. `drawStrip(y, h)` issues one
  // strip's escape draw (rows [y, y+h)). The scissor approach keeps gl_FragCoord
  // identical to one big draw, so the result is BIT-IDENTICAL. Returns true if it ran
  // to completion, false if a newer render/gesture superseded it (gen guard).
  async _drawTiledEscape(drawStrip, gen) {
    const W = this.cW, H = this.cH;
    this.gpu.clearSn(W, H, -1);                 // not-yet-drawn rows read as interior
    this._setGpuLUT();
    const stripH = this._stripRows();
    for (let y = 0; y < H; y += stripH) {
      if (gen !== this.gen) return false;       // superseded -> stop, don't touch the canvas
      const h = Math.min(stripH, H - y);
      drawStrip(y, h);
      this.gpu.gl.flush();                       // submit this strip as its own GPU command
      this.gpu.colorize(this._gpuColorOpts());
      this._blitGpu();                           // progressive reveal of what's computed so far
      await this._raf();                         // yield: let the GPU drain + the page paint/respond
    }
    return gen === this.gen;
  }

  async _renderGpuNaive() {
    const W = this.cW, H = this.cH, gen = this.gen;   // compute res (ss × display)
    const aspect = W / H, scale = (2 * this.radius) / H;
    const cx = toDouble(this.cx, this.prec), cy = toDouble(this.cy, this.prec);
    const ox = cx - this.radius * aspect, oy = cy - this.radius;
    this.onStatus({ phase: 'start', engine: 'gpu-naive', maxIter: this.maxIter, zoom: this.zoomLevel() });
    try {
      const done = await this._drawTiledEscape(
        (y, h) => this.gpu.renderNaive({ ox, oy, scale, maxIter: this.maxIter,
                                         width: W, height: H, df64: false, stripY: y, stripH: h }), gen);
      if (!done) return;
      this._refMeta = { engine: 'gpu-naive', refLen: 0, relocations: 0 };
      this._finishGpu('gpu-naive', 0);
    } catch (e) { if (gen === this.gen) this._gpuFail(e); }
  }

  _startGpuPerturb() {
    this._spawnPool(1); // one worker computes the reference orbit; GPU rasterizes
    // Send the COMPUTE resolution: the worker derives scale=(2r)/height for the
    // supersampled grid (offX/offY are resolution-independent).
    this._pool[0].postMessage({
      type: 'computeRef', gen: this.gen,
      cxRaw: this.cx.toString(), cyRaw: this.cy.toString(), prec: this.prec,
      radius: this.radius, width: this.cW, height: this.cH,
      maxIter: this.maxIter, engine: 'perturb', wantCoarse: false,
    });
    this.onStatus({ phase: 'start', engine: 'gpu-perturb', maxIter: this.maxIter, zoom: this.zoomLevel() });
  }

  async _renderGpuPerturb(p) {
    const W = this.cW, H = this.cH, gen = this.gen;   // compute res (ss × display)
    const fe = this._mode === 'gpu-perturb-fe';       // floatexp-precision band, below the df64 floor
    try {
      this.gpu.uploadReferenceDf64(p.zx, p.zy);       // reference is df64 in both paths
      const args = { ox: p.offX, oy: p.offY, scale: p.scale, refLen: p.len,
                     maxIter: this.maxIter, glitchTol: 0, width: W, height: H };
      // The deep floatexp-precision band uses the RESCALED engine: same depth range and
      // ~46-bit precision as renderPerturbFloatexp (it still does escape/rebase in exact
      // floatexp), but a ~1.3-2× faster shared-exponent update. renderPerturbFloatexp
      // remains in the renderer as the reference/oracle (tools/validate-gpu.mjs gates both).
      // Both draw in horizontal strips (_drawTiledEscape) so a deep frame (maxIter ~55k
      // at 2^218) never exceeds the GPU watchdog — the actual barrier past ~2^218.
      const drawStrip = fe
        ? (y, h) => this.gpu.renderPerturbRescaled({ ...args, stripY: y, stripH: h })
        : (y, h) => this.gpu.renderPerturbDf64({ ...args, stripY: y, stripH: h });
      const done = await this._drawTiledEscape(drawStrip, gen);
      if (!done) return;                              // superseded; a newer render owns the canvas
      this._terminatePool();
      this._finishGpu(fe ? 'gpu-perturb-fe' : 'gpu-perturb', 0);
    } catch (e) { if (gen === this.gen) this._gpuFail(e); }
  }

  _recolorGpu() {
    try {
      this._setGpuLUT();
      this.gpu.colorize(this._gpuColorOpts());
      this._blitGpu();
      this.sctx.drawImage(this.canvas, 0, 0);
    } catch (e) { this.render(); }
  }

  _distributeBands(params) {
    // round-robin row-bands across the pool for load balance (interleaved so
    // each worker gets a spread of cheap + expensive rows). At compute res.
    const H = this.cH, P = this._pool.length, B = this.bandRows;
    const starts = [];
    for (let y = 0; y < H; y += B) starts.push(y);
    this._tilesLeft = this._pool.length;
    for (let w = 0; w < P; w++) {
      const bands = [];
      for (let k = w; k < starts.length; k += P) bands.push(starts[k]);
      // postMessage structured-clones `params` (incl. the ref arrays) per send,
      // so each worker gets its own copy — no manual cloning, no transfer.
      this._pool[w].postMessage({
        type: 'render', gen: this.gen, params, bands, bandRows: B,
        width: this.cW, height: this.cH,
      });
    }
  }

  _onWorker(m, gen) {
    if (gen !== this.gen) return; // stale message from a superseded render
    if (m.type === 'progress') {
      this.onStatus({ phase: m.phase, i: m.i, total: m.total });
    } else if (m.type === 'refReady') {
      this._refMeta = { engine: m.engine, refLen: m.refLen, relocations: m.relocations };
      if (this._mode === 'gpu-perturb' || this._mode === 'gpu-perturb-fe') { // GPU rasterizes from the worker's reference
        this._refMeta.engine = this._mode;
        this._renderGpuPerturb(m.params);
        return;
      }
      const c = m.coarse;
      colorizeBlocks(this.img.data, c.sn, this.cW, this.cH, c.snW, c.snH, c.step, this.paletteOpts);
      this._paintCtx.putImageData(this.img, 0, 0);
      this._schedulePresent();
      this._distributeBands(m.params); // params keeps the (transferred-back) arrays
    } else if (m.type === 'band') {
      const sn = m.sn;
      for (let j = 0; j < m.h; j++) {
        const dst = (m.y0 + j) * this.cW;
        const src = j * m.w;
        for (let i = 0; i < m.w; i++) this._sn[dst + i] = sn[src + i];
      }
      colorizeRegion(this.img.data, sn, this.cW, { x0: m.x0, y0: m.y0, w: m.w, h: m.h }, this.paletteOpts);
      this._paintCtx.putImageData(this.img, 0, 0, m.x0, m.y0, m.w, m.h);
      this._schedulePresent();
    } else if (m.type === 'tilesDone') {
      this._glitchAcc += m.glitches;
      this._tilesLeft--;
      if (this._tilesLeft <= 0) {
        this.rendering = false;
        this._clearPresent();
        this._presentNow();                       // flush final supersample downscale
        this.sctx.drawImage(this.canvas, 0, 0); // snapshot for gesture previews
        const meta = this._refMeta || {};
        this.onStatus({ phase: 'done', glitches: this._glitchAcc, refLen: meta.refLen || 0, relocations: meta.relocations || 0, engine: meta.engine, zoom: this.zoomLevel() });
      }
    } else if (m.type === 'error') {
      this.rendering = false;
      this.onStatus({ error: m.message });
    }
  }

  _recolor() {
    // recolor whole image from cached sn (instant palette change), at compute res
    colorizeRegion(this.img.data, this._sn, this.cW,
      { x0: 0, y0: 0, w: this.cW, h: this.cH }, this.paletteOpts);
    this._paintCtx.putImageData(this.img, 0, 0);
    this._presentNow();
    this.sctx.drawImage(this.canvas, 0, 0);
  }

  // ---- gesture preview ----
  _applyPreview() {
    const t = this.T;
    this.ctx.save();
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.backingW, this.backingH);
    // Point filtering (nearest), not bilinear: scaling the last frame during a
    // zoom/pan gesture stays crisp instead of going soft. The sharp re-render
    // replaces it once the gesture settles.
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.setTransform(t.a, 0, 0, t.a, t.e, t.f);
    this.ctx.drawImage(this.stable, 0, 0);
    this.ctx.restore();
  }

  // Start a preview: snapshot the current frame as the scale base and cancel any
  // in-flight render so zoom/pan is instant and nothing renders mid-gesture. The
  // real (high-res) render is deferred to _endGesture (touch up) or the settle
  // timer (wheel/buttons). Idempotent — only the first call of a gesture acts.
  _beginPreview() {
    if (this.T) return;
    this._clearSettle();
    this.sctx.drawImage(this.canvas, 0, 0); // current frame becomes the base image
    this.T = { a: 1, e: 0, f: 0 };
    this.gen++;                 // invalidate any in-flight worker messages
    this._terminatePool();
    this.rendering = false;
  }

  _clearSettle() { if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = 0; } }

  // Debounced commit for momentum-free zoom sources (wheel, buttons, click-to-zoom):
  // keep showing the scaled preview, then render sharply once motion stops.
  _scheduleSettle(delay = 220) {
    this._clearSettle();
    this._settleTimer = setTimeout(() => { this._settleTimer = 0; this._endGesture(); }, delay);
  }

  // Zoom by `factor` (radius *= factor) about backing pixel (px,py), keeping that
  // point fixed. Renders the current image scaled (preview) immediately and defers
  // the real render until the zoom settles. Used by wheel and the zoom buttons.
  zoomBy(factor, px = this.backingW / 2, py = this.backingH / 2) {
    this._beginPreview();
    const s = 1 / factor;            // display scale (radius shrinks -> image grows)
    this.T.a *= s;
    this.T.e = px * (1 - s) + s * this.T.e;
    this.T.f = py * (1 - s) + s * this.T.f;
    this._applyPreview();
    this._scheduleSettle();
  }

  // Click-to-zoom: recenter the clicked backing pixel (px,py) to the screen center
  // AND zoom by `factor` (radius *= factor; <1 zooms in). The clicked complex point
  // becomes the new view center. Like zoomBy it shows the scaled preview instantly
  // and defers the sharp render to the settle timer. The transform G applied in
  // displayed space is "scale by s=1/factor about (px,py), then translate (px,py)
  // to center"; composing G∘T gives the update below (so it composes with any
  // preview already in progress, and _endGesture folds it into the HP view state:
  // new center = the complex point at (px,py), new radius = radius*factor).
  clickZoom(px, py, factor = 0.5) {
    if (!this.backingW) return;
    this._beginPreview();
    const s = 1 / factor;
    const t = this.T;
    t.e = s * t.e + this.backingW / 2 - s * px;   // uses the OLD t.e/t.f
    t.f = s * t.f + this.backingH / 2 - s * py;
    t.a = s * t.a;
    this._applyPreview();
    this._scheduleSettle();
  }

  _endGesture() {
    if (!this.T) return;
    const t = this.T;
    const W = this.backingW, H = this.backingH;
    // complex point now shown at screen center, from the OLD stable image
    const ox = (W / 2 - t.e) / t.a;
    const oy = (H / 2 - t.f) / t.a;
    const { dx, dy } = this._pixelDelta(ox, oy);
    this.cx += fromDouble(dx, this.prec);
    this.cy += fromDouble(dy, this.prec);
    this.radius = this.radius / t.a;
    this._afterRadiusChange();
    this.T = null;
    this.render();
  }

  _installGestures() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    const down = (ev) => {
      c.setPointerCapture?.(ev.pointerId);
      this._pointers.set(ev.pointerId, this._toBacking(ev.clientX, ev.clientY));
      if (this._pointers.size === 2) {
        const pts = [...this._pointers.values()];
        this._pinch = {
          startDist: dist(pts[0], pts[1]),
          startMid: mid(pts[0], pts[1]),
        };
      }
      // A single pointerdown starts nothing yet: a tap with no movement must not
      // cancel an in-flight render. Pan/pinch previews begin lazily on the first
      // real move; a tap that never moves becomes a click-to-zoom on pointerup.
    };
    const move = (ev) => {
      if (!this._pointers.has(ev.pointerId)) return;
      const prev = this._pointers.get(ev.pointerId);
      const cur = this._toBacking(ev.clientX, ev.clientY);
      this._pointers.set(ev.pointerId, cur);
      if (this._pointers.size === 1) {
        const dx = cur.x - prev.x, dy = cur.y - prev.y;
        if (!this.T && Math.hypot(dx, dy) < 1) return; // ignore sub-pixel jitter
        this._beginPreview(); // lazy: snapshot + cancel in-flight render on real motion
        // pan
        this.T.e += dx;
        this.T.f += dy;
        this._applyPreview();
      } else if (this._pointers.size === 2 && this._pinch) {
        this._beginPreview();
        const pts = [...this._pointers.values()];
        const d = dist(pts[0], pts[1]);
        const mp = mid(pts[0], pts[1]);
        const k = d / (this._pinch._lastDist || this._pinch.startDist);
        // scale around current midpoint
        this.T.a *= k;
        this.T.e = mp.x + (this.T.e - mp.x) * k;
        this.T.f = mp.y + (this.T.f - mp.y) * k;
        // translate by midpoint movement
        if (this._pinch._lastMid) {
          this.T.e += mp.x - this._pinch._lastMid.x;
          this.T.f += mp.y - this._pinch._lastMid.y;
        }
        this._pinch._lastDist = d;
        this._pinch._lastMid = mp;
        this._applyPreview();
      }
    };
    const up = (ev) => {
      if (!this._pointers.has(ev.pointerId)) return;
      const downPos = this._pointers.get(ev.pointerId); // ~tap location (down≈up)
      this._pointers.delete(ev.pointerId);
      if (this._pointers.size === 0) {
        this._pinch = null;
        if (this.T) { this._endGesture(); return; } // a pan/pinch preview was active
        // No preview started -> a tap/click with no drag: click-to-zoom, recentering
        // on the point. Shift / Ctrl / right-button zoom OUT instead of IN.
        if (ev.type !== 'pointercancel') {
          const out = ev.shiftKey || ev.ctrlKey || ev.button === 2;
          this.clickZoom(downPos.x, downPos.y, out ? 2 : 0.5);
        }
      } else if (this._pointers.size === 1) {
        // transition pinch -> pan; reset pinch refs
        this._pinch = null;
      }
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    // right-click zooms out; suppress the browser context menu on the canvas
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());

    // wheel zoom (desktop): scaled preview now, sharp render once scrolling stops.
    // Wheel zooms about the cursor (keeps the point under it fixed) rather than
    // recentering — the expected scroll-to-zoom feel; a click recenters instead.
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = this._toBacking(ev.clientX, ev.clientY);
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
      this.zoomBy(factor, p.x, p.y);
    }, { passive: false });
  }
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
