// render.js — orchestrates a perturbation render: pick a good reference, then
// rasterize. The reference must have an orbit at least as long as the deepest
// pixel needs, otherwise perturbation degrades. We auto-relocate the reference
// to the deepest probed pixel (standard "rebase to deepest pixel" technique).
//
// View in high-precision form:
//   viewHP = { x: BigInt, y: BigInt, prec: number, radius: number, width, height }
// where (x,y) is the center in fixed point at `prec`, radius is the half-height
// in the complex plane (a plain double, fine down to ~2^-1000).

import { computeReference } from './reference.js';
import { escapePerturb, pixelDelta } from './perturb.js';
import { fromDouble, toDouble } from './bignum.js';

// Below this radius, plain doubles lose the boundary; use perturbation.
// Above it, naive doubles are fast, GPU-friendly, and as accurate as any
// 53-bit method (perturbation has no shallow-zoom advantage — see NOTES).
export const PERTURB_RADIUS = Math.pow(2, -40);

export function engineForRadius(radius) {
  return radius < PERTURB_RADIUS ? 'perturb' : 'naive';
}

// GPU dispatch (see NOTES "GPU acceleration"). Empirically validated thresholds:
//   radius >= 2^-2   : naive f32     (shallow/home; single-ref perturb inappropriate)
//   2^-2 .. 2^-112   : perturb df64   (deep workhorse; cheap ~46-bit, no exponent)
//   2^-112 .. 2^-340 : perturb floatexp (df64 mantissa + int exponent — works below
//                      the df64 float32-exponent floor where dc/dz ~2^-270 underflow;
//                      this is the GPU path for ~2^270 zooms)
//   below 2^-340     : null -> CPU perturbation (ultimate oracle/fallback)
export const GPU_NAIVE_RADIUS = Math.pow(2, -2);   // >= this -> GPU naive f32
export const GPU_PERTURB_FLOOR = Math.pow(2, -112); // >= this (and < naive) -> GPU perturb df64
export const GPU_PERTURB_FE_FLOOR = Math.pow(2, -340); // >= this (and < df64 floor) -> GPU perturb floatexp

// Returns 'naive' | 'perturb' | 'perturb-fe' | null (null = use the CPU engines).
export function gpuEngineForRadius(radius) {
  if (radius >= GPU_NAIVE_RADIUS) return 'naive';
  if (radius >= GPU_PERTURB_FLOOR) return 'perturb';
  if (radius >= GPU_PERTURB_FE_FLOOR) return 'perturb-fe';
  return null;
}

// Auto iteration budget: grows with zoom depth so deep structure resolves.
// Deep boundary filaments need many iterations; too low and everything reads as
// "inside" (solid). This is generous on purpose — the UI slider lets users trim
// it for speed. Empirically ~250/octave keeps the seahorse/spiral resolved.
export function autoMaxIter(radius, base = 400) {
  const zoomBits = radius > 0 ? Math.max(0, -Math.log2(radius)) : 0;
  return Math.min(2_000_000, Math.round(base + zoomBits * 250));
}

// Probe a coarse grid with the current reference to find the deepest pixel
// (highest iteration count). Returns { maxIter: count, px, py }.
function probeDeepest(ref, view, maxIter, gridN = 17) {
  let best = -1, bpx = 0, bpy = 0;
  for (let gy = 0; gy < gridN; gy++) {
    const py = Math.round((gy / (gridN - 1)) * (view.height - 1));
    for (let gx = 0; gx < gridN; gx++) {
      const px = Math.round((gx / (gridN - 1)) * (view.width - 1));
      const { dcx, dcy } = pixelDelta(view, px, py);
      const r = escapePerturb(ref, dcx, dcy, maxIter);
      if (r.n > best) { best = r.n; bpx = px; bpy = py; }
    }
  }
  return { count: best, px: bpx, py: bpy };
}

// Choose a reference for the view. Starts at the center and relocates toward the
// deepest pixel until the reference orbit is long enough (or we hit a cap).
// Returns { ref, center: {x,y,prec}, relocations }.
export function chooseReference(viewHP, maxIter, opts = {}) {
  const { prec } = viewHP;
  const maxReloc = opts.maxRelocations ?? 4;
  let cx = viewHP.x, cy = viewHP.y;
  let ref = computeReference({ x: cx, y: cy, prec }, maxIter, opts.onProgress);
  let relocations = 0;

  while (relocations < maxReloc && ref.len < maxIter) {
    const deepest = probeDeepest(ref, viewHP, maxIter);
    // If the deepest pixel needs no more than the current reference provides,
    // the reference is adequate.
    if (deepest.count <= ref.len) break;
    // Relocate the reference to the deepest pixel (exact HP coordinate).
    const { dcx, dcy } = pixelDelta(viewHP, deepest.px, deepest.py);
    const nx = cx + fromDouble(dcx, prec);
    const ny = cy + fromDouble(dcy, prec);
    const nref = computeReference({ x: nx, y: ny, prec }, maxIter, opts.onProgress);
    relocations++;
    if (nref.len <= ref.len) { // no improvement — keep the better one and stop
      if (nref.len > ref.len) { ref = nref; cx = nx; cy = ny; }
      break;
    }
    ref = nref; cx = nx; cy = ny;
  }
  return { ref, center: { x: cx, y: cy, prec }, relocations };
}

// Full render: choose reference, then rasterize the whole image (or a region).
// Returns { sn, iters, glitches, refLen, relocations, refCenter }.
export function renderImage(viewHP, maxIter, opts = {}) {
  const { ref, center, relocations } = chooseReference(viewHP, maxIter, opts);
  const view = { radius: viewHP.radius, width: viewHP.width, height: viewHP.height };
  const region = opts.region || { x0: 0, y0: 0, w: view.width, h: view.height };

  const aspect = view.width / view.height;
  const scale = (2 * view.radius) / view.height;
  // dc origin must be measured from the (possibly relocated) reference center,
  // which differs from the view center by (center - viewHP center).
  const cdx = center.x - viewHP.x; // BigInt fixed-point offset of ref from view center
  const cdy = center.y - viewHP.y;
  const refOffX = toDouble(cdx, viewHP.prec);
  const refOffY = toDouble(cdy, viewHP.prec);

  const offX = -view.radius * aspect - refOffX; // dc.x at px=0 relative to ref
  const offY = -view.radius - refOffY;

  const sn = new Float64Array(region.w * region.h);
  const iters = new Int32Array(region.w * region.h);
  let glitches = 0;
  for (let j = 0; j < region.h; j++) {
    const py = region.y0 + j;
    const dcy = offY + py * scale;
    for (let i = 0; i < region.w; i++) {
      const px = region.x0 + i;
      const dcx = offX + px * scale;
      const res = escapePerturb(ref, dcx, dcy, maxIter);
      const idx = j * region.w + i;
      iters[idx] = res.n;
      sn[idx] = res.n >= maxIter ? -1 : res.sn;
      if (res.glitched) glitches++;
    }
  }
  return { sn, iters, glitches, refLen: ref.len, relocations, refCenter: center };
}
