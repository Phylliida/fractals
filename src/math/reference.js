// reference.js — high-precision reference orbit for perturbation.
//
// Given a center C = (cx, cy) as fixed-point BigInts at precision `prec`, iterate
// Z_{n+1} = Z_n^2 + C in high precision and export the orbit as Float64Arrays
// (Z_n are O(1) magnitude, so doubles capture them with full relative precision).
//
// Output feeds the double-precision perturbation engine (perturb.js).

import { mulShift, toDouble } from './bignum.js';

// Exact escape count of a single point computed entirely in BigInt fixed point.
// This is the DEEP-ZOOM ground-truth oracle (slow, but exact at any depth).
// Uses the same bailout as naive.js / perturb.js so counts are comparable.
//   cx, cy : fixed-point BigInts at precision `prec`
// Returns the integer escape iteration (maxIter => did not escape).
export function escapeBigInt(cx, cy, prec, maxIter, bailoutSq = 1 << 16) {
  const bail = BigInt(bailoutSq) << BigInt(prec);
  let zx = 0n, zy = 0n;
  for (let n = 1; n <= maxIter; n++) {
    const zx2 = mulShift(zx, zx, prec);
    const zy2 = mulShift(zy, zy, prec);
    const ny = mulShift(2n * zx, zy, prec) + cy;
    const nx = zx2 - zy2 + cx;
    zx = nx; zy = ny;
    if ((mulShift(zx, zx, prec) + mulShift(zy, zy, prec)) > bail) return n;
  }
  return maxIter;
}

// Compute the reference orbit.
//   center: { x: BigInt, y: BigInt, prec: number }
//   maxIter: cap on orbit length
//   onProgress(i, maxIter): optional, called every ~4096 iterations
// Returns { zx, zy, z2, len, escaped }
//   zx,zy : Float64Array of the orbit (index n = z_n), length = len+1 incl z_0=0
//   z2    : Float64Array of |z_n|^2 (for glitch detection)
//   len   : number of valid iterations (z_0..z_len); escaped at z_len if escaped
//   escaped: whether the reference escaped before maxIter
export function computeReference(center, maxIter, onProgress) {
  const { x: cx, y: cy, prec } = center;
  const cap = maxIter + 1;
  const zx = new Float64Array(cap);
  const zy = new Float64Array(cap);
  const z2 = new Float64Array(cap);
  const four = 4n << BigInt(prec);

  let bx = 0n, by = 0n; // BigInt fixed-point Z
  zx[0] = 0; zy[0] = 0; z2[0] = 0;
  let len = 0;
  let escaped = false;

  for (let n = 1; n <= maxIter; n++) {
    // Z = Z^2 + C  (complex)
    const bx2 = mulShift(bx, bx, prec);
    const by2 = mulShift(by, by, prec);
    const newY = mulShift(2n * bx, by, prec) + cy;
    const newX = bx2 - by2 + cx;
    bx = newX; by = newY;

    const dx = toDouble(bx, prec);
    const dy = toDouble(by, prec);
    zx[n] = dx; zy[n] = dy;
    const m2 = dx * dx + dy * dy;
    z2[n] = m2;
    len = n;

    if ((bx2 + by2) > four) { escaped = true; break; }
    if (onProgress && (n & 4095) === 0) onProgress(n, maxIter);
  }
  if (onProgress) onProgress(len, maxIter);

  return {
    zx: zx.subarray(0, len + 1),
    zy: zy.subarray(0, len + 1),
    z2: z2.subarray(0, len + 1),
    len,
    escaped,
  };
}
