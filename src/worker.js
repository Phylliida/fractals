// worker.js — module worker for the render pool. Two roles:
//   1. 'computeRef' (sent to one worker): pick/compute the reference orbit (deep)
//      or naive params (shallow), emit a quick coarse pass, and hand the data
//      back to the main thread.
//   2. 'render' (sent to every worker): render an assigned set of row-bands
//      using the reference data, streaming each band back.
//
// Cancellation: the main thread terminates the whole pool on a view change, so
// workers just run to completion. Every message carries `gen` for safety.
//
// Protocol:
//   in  : { type:'computeRef', gen, cxRaw, cyRaw, prec, radius, width, height,
//           maxIter, engine? }
//         { type:'render', gen, params, bands:[y0,...], bandRows }
//   out : { type:'progress', gen, phase, i, total }
//         { type:'refReady', gen, engine, params, relocations, refLen,
//                            coarse:{sn,snW,snH,step} }   (+transfer arrays)
//         { type:'band', gen, x0, y0, w, h, sn }          (+transfer sn.buffer)
//         { type:'tilesDone', gen, glitches }
//         { type:'error', gen, message }
//
// `params` is engine-specific and self-contained so a tile worker needs nothing
// else:  perturb -> { engine:'perturb', zx, zy, z2, len, offX, offY, scale,
//                     maxIter, width }
//        naive   -> { engine:'naive', x0, y0, scale, maxIter, width }

import { escapeNaive } from './math/naive.js';
import { chooseReference, engineForRadius } from './math/render.js';
import { escapePerturb } from './math/perturb.js';
import { toDouble } from './math/bignum.js';

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'computeRef') computeRef(m);
    else if (m.type === 'render') renderBands(m);
  } catch (err) {
    self.postMessage({ type: 'error', gen: m.gen, message: String((err && err.stack) || err) });
  }
};

// Build a per-pixel escape closure + a glitch accumulator from `params`.
function makeEscape(params) {
  const state = { glitches: 0 };
  let fn;
  if (params.engine === 'perturb') {
    const ref = { zx: params.zx, zy: params.zy, z2: params.z2, len: params.len };
    const { offX, offY, scale, maxIter } = params;
    fn = (px, py) => {
      const r = escapePerturb(ref, offX + px * scale, offY + py * scale, maxIter);
      if (r.glitched) state.glitches++;
      return r.n >= maxIter ? -1 : r.sn;
    };
  } else {
    const { x0, y0, scale, maxIter } = params;
    fn = (px, py) => {
      const r = escapeNaive(x0 + px * scale, y0 + py * scale, maxIter);
      return r.n >= maxIter ? -1 : r.sn;
    };
  }
  return { fn, state };
}

function coarsePass(escapeFn, width, height, step) {
  const snW = Math.ceil(width / step);
  const snH = Math.ceil(height / step);
  const sn = new Float64Array(snW * snH);
  for (let sy = 0; sy < snH; sy++) {
    const py = Math.min(sy * step, height - 1);
    for (let sx = 0; sx < snW; sx++) {
      const px = Math.min(sx * step, width - 1);
      sn[sy * snW + sx] = escapeFn(px, py);
    }
  }
  return { sn, snW, snH, step };
}

function computeRef(job) {
  const { gen, cxRaw, cyRaw, prec, radius, width, height, maxIter } = job;
  const cx = BigInt(cxRaw), cy = BigInt(cyRaw);
  const engine = job.engine || engineForRadius(radius);
  const aspect = width / height;
  const scale = (2 * radius) / height;

  let params, relocations = 0, refLen = 0;
  if (engine === 'perturb') {
    const viewHP = { x: cx, y: cy, prec, radius, width, height };
    const sel = chooseReference(viewHP, maxIter, {
      onProgress: (i, total) => self.postMessage({ type: 'progress', gen, phase: 'reference', i, total }),
    });
    const { ref, center } = sel;
    relocations = sel.relocations; refLen = ref.len;
    const refOffX = toDouble(center.x - cx, prec);
    const refOffY = toDouble(center.y - cy, prec);
    params = {
      engine, zx: ref.zx, zy: ref.zy, z2: ref.z2, len: ref.len,
      offX: -radius * aspect - refOffX, offY: -radius - refOffY, scale, maxIter, width,
    };
  } else {
    const cxd = toDouble(cx, prec), cyd = toDouble(cy, prec);
    params = { engine, x0: cxd - radius * aspect, y0: cyd - radius, scale, maxIter, width };
  }

  // GPU does the full render itself, so skip the CPU coarse pass when not wanted.
  const wantCoarse = job.wantCoarse !== false;
  const coarse = wantCoarse ? coarsePass(makeEscape(params).fn, width, height, 8) : null;

  // arrays we hand off (and lose) to the main thread for tile distribution / GPU upload
  const transfers = [];
  if (coarse) transfers.push(coarse.sn.buffer);
  if (engine === 'perturb') transfers.push(params.zx.buffer, params.zy.buffer, params.z2.buffer);
  self.postMessage({ type: 'refReady', gen, engine, params, relocations, refLen, coarse }, transfers);
}

function renderBands(job) {
  const { gen, params, bands, bandRows, width, height } = job;
  const { fn, state } = makeEscape(params);
  for (const y0 of bands) {
    const h = Math.min(bandRows, height - y0);
    const sn = new Float64Array(width * h);
    for (let j = 0; j < h; j++) {
      const py = y0 + j;
      for (let px = 0; px < width; px++) sn[j * width + px] = fn(px, py);
    }
    self.postMessage({ type: 'band', gen, x0: 0, y0, w: width, h, sn }, [sn.buffer]);
  }
  self.postMessage({ type: 'tilesDone', gen, glitches: state.glitches });
}
