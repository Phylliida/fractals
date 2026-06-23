// Unit tests for the pure GPU-path helpers: the floatexp split (feSplit) that
// lets ~2^-270 deltas cross into the shader as a df64 mantissa + int exponent,
// and the depth->engine dispatch (incl. the new floatexp band). No GL here — the
// shader math itself is validated headless by tools/validate-gpu.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feSplit, df64Split } from '../../src/gpu/renderer.js';
import {
  gpuEngineForRadius, GPU_NAIVE_RADIUS, GPU_PERTURB_FLOOR, GPU_PERTURB_FE_FLOOR,
} from '../../src/math/render.js';

// feSplit(v) = {hi,lo,e} with value = (hi+lo)*2^e and |hi| in [0.5,1). The whole
// point is that tiny values (2^-270), which underflow a bare float32 (2^-126),
// reconstruct to ~46-bit relative accuracy through the mantissa+exponent split.
test('feSplit round-trips across a huge exponent range to ~46 bits', () => {
  const vals = [1, -1, 0.5, 1.9, 123.456, -0.0007,
    Math.pow(2, -90), Math.pow(2, -130), Math.pow(2, -270), -Math.pow(2, -300), Math.pow(2, -340)];
  for (const v of vals) {
    const { hi, lo, e } = feSplit(v);
    // mantissa normalized into [0.5, 1)
    assert.ok(Math.abs(hi) >= 0.5 && Math.abs(hi) < 1, `mantissa ${hi} not in [0.5,1) for ${v}`);
    const recon = (hi + lo) * Math.pow(2, e);
    const relErr = Math.abs(recon - v) / Math.abs(v);
    assert.ok(relErr < Math.pow(2, -44), `relErr ${relErr} too big for ${v}`);
  }
});

test('feSplit handles zero with the exponent sentinel', () => {
  const z = feSplit(0);
  assert.equal(z.hi, 0);
  assert.equal(z.lo, 0);
  assert.ok(z.e <= -100000);
});

test('df64Split preserves the value to ~46 bits', () => {
  for (const v of [1.5, -0.333333333333, 1e-12, 65536.5]) {
    const [hi, lo] = df64Split(v);
    assert.ok(Math.abs((hi + lo) - v) <= Math.abs(v) * Math.pow(2, -44) + 1e-300);
  }
});

// Depth dispatch: naive (shallow) -> df64 perturb -> floatexp perturb -> CPU.
test('gpuEngineForRadius picks the right engine per depth band', () => {
  assert.equal(gpuEngineForRadius(1.5), 'naive');               // home
  assert.equal(gpuEngineForRadius(GPU_NAIVE_RADIUS), 'naive');  // boundary inclusive
  assert.equal(gpuEngineForRadius(Math.pow(2, -3)), 'perturb'); // df64 band
  assert.equal(gpuEngineForRadius(Math.pow(2, -50)), 'perturb');
  assert.equal(gpuEngineForRadius(GPU_PERTURB_FLOOR), 'perturb');
  // below the df64 float32-exponent floor -> floatexp (this is the ~2^270 band)
  assert.equal(gpuEngineForRadius(Math.pow(2, -150)), 'perturb-fe');
  assert.equal(gpuEngineForRadius(Math.pow(2, -272)), 'perturb-fe'); // the reference 2^270 view
  assert.equal(gpuEngineForRadius(GPU_PERTURB_FE_FLOOR), 'perturb-fe');
  // beyond the validated floatexp range -> CPU perturbation (oracle/fallback)
  assert.equal(gpuEngineForRadius(Math.pow(2, -400)), null);
});

test('GPU depth floors are ordered and sane', () => {
  assert.ok(GPU_NAIVE_RADIUS > GPU_PERTURB_FLOOR);
  assert.ok(GPU_PERTURB_FLOOR > GPU_PERTURB_FE_FLOOR);
  assert.ok(GPU_PERTURB_FE_FLOOR <= Math.pow(2, -272)); // covers the 2^270 reference view
});
