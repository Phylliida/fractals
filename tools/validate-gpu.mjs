// validate-gpu.mjs — launch the sandbox chromium, load the GPU harness, and
// compare GPU renders against the CPU oracles across a range of zoom depths.
// Prints a table and exits non-zero if any case exceeds its tolerance.
//
//   node tools/validate-gpu.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { launchOpts } from './chromium-launch.mjs';

const PORT = process.env.PORT || 8139;
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT }, stdio: 'ignore' });
const baseURL = `http://127.0.0.1:${PORT}`;
async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(baseURL + '/test/gpu/harness.html'); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let failed = 0;
// Honest metric: two finite-precision methods will disagree on measure-zero
// chaotic boundary pixels (see arbiter — those are precision, not bugs). So we
// gate on BULK agreement: the fraction of pixels differing by >1 count must be
// small, and the MEAN smooth-count difference over escaped pixels must be tiny.
function check(name, res, tol) {
  const frac = res.compared ? res.mism / res.compared : 0;       // any count diff
  const ok = res.insideMismatch <= (tol.inside ?? Infinity)
    && frac <= (tol.mismFrac ?? 1)
    && res.meanAbs <= (tol.meanAbs ?? Infinity);
  if (!ok) failed++;
  const ex = (res.examples || []).slice(0, 3).map((e) => `[${e.i},${e.j}]cpu${e.cpu}/gpu${e.gpu}${e.kind ? '(' + e.kind + ')' : ''}`).join(' ');
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ` +
    `mism=${(frac * 100).toFixed(3).padStart(7)}% inside=${String(res.insideMismatch).padStart(4)} ` +
    `meanΔsn=${res.meanAbs.toExponential(2)} maxΔsn=${res.maxAbs.toExponential(2)}` +
    (ok ? '' : '   ' + ex)
  );
}

try {
  await waitServer();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); failed++; });
  await page.goto(baseURL + '/test/gpu/harness.html');
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });

  const W = 200, H = 200;
  const init = await page.evaluate(([w, h]) => window.__gpu.init(w, h), [W, H]);
  console.log('renderer supported:', init.supported, init.ok);
  if (!init.supported) throw new Error('GPU not supported in this browser');
  console.log('info:', JSON.stringify(await page.evaluate(() => window.__gpu.info())));
  console.log('');

  // --- NAIVE float32: map a view of half-height `radius` centered at (cx,cy) ---
  // ox/oy/scale chosen so texel (i+.5,j+.5) covers the view; we don't need the
  // viewer's exact mapping, just a self-consistent one the oracle mirrors.
  function naiveParams(cx, cy, radius, maxIter, df64) {
    const scale = (2 * radius) / H;
    return { ox: cx - radius * (W / H), oy: cy - radius, scale, maxIter, width: W, height: H, df64, checkStep: 1 };
  }

  const autoIter = (bits) => Math.round(400 + bits * 250);

  // ACTIVE DISPATCH ENGINE 1 — naive float32, used ONLY for the shallow band
  // (radius >= 2^-3), where the view shows large portions of the set and a
  // single-reference perturbation is inappropriate. Bulk is exact; isolated
  // boundary pixels may flip (24-bit coordinate on chaotic pixels — see arbiter),
  // so we gate on mean Δsn + mismatch fraction, never max.
  console.log('== naive f32 (active for radius >= 2^-2) ==');
  for (const [name, cx, cy, bits] of [
    ['home               2^0', -0.5, 0, 0],
    ['bulb              2^-1', -0.5, 0, 1],
    ['offset            2^-2', -0.10, 0.95, 2],
    ['valley            2^-2', -0.745, 0.113, 2],
  ]) {
    const r = 1.5 * 2 ** -bits;
    const res = await page.evaluate((p) => window.__gpu.compareNaive(p), naiveParams(cx, cy, r, autoIter(bits), false));
    check(name, res, { inside: 40, mismFrac: 0.02, meanAbs: 2.0 });
  }

  // ACTIVE DISPATCH ENGINE 2 — perturbation df64, used for 2^-2 .. ~2^-112.
  // Accurate across the whole range (even at the worst-case seahorse valley);
  // residual <1.5% boundary pixels reflect the df64 (46-bit) vs CPU-double
  // (53-bit) gap on chaotic pixels (meanΔsn < 1). Tested at the valley.
  console.log('\n== perturb df64 (active for 2^-3 .. 2^-112) ==');
  const SH = '-0.743643887037158704752191506114774', SI = '0.131825904205311970493132056385139';
  for (const bits of [3, 6, 12, 22, 35, 50, 70, 90, 110]) {
    const r = 1.5 * 2 ** -bits, it = autoIter(bits);
    const res = await page.evaluate((q) => window.__gpu.comparePerturb(q),
      { re: SH, im: SI, radius: r, maxIter: it, width: W, height: H, checkStep: 2, glitchTol: 0, df64: true });
    check(`perturb df64  2^-${bits}  ref=${res.refLen}`, res, { inside: 8, mismFrac: 0.02, meanAbs: 1.0 });
  }

  // ACTIVE DISPATCH ENGINE 3 — perturbation FLOATEXP (df64 mantissa + int exp),
  // the GPU deep path BELOW the df64 float32-exponent floor (~2^-112). Same ~46-bit
  // mantissa precision as df64 but with an unbounded exponent, so dc/dz ~2^-270
  // don't underflow float32 (min normal 2^-126). Validated vs the CPU perturbation
  // oracle (doubles — correct to ~2^-1000). `esc` = escaping pixels compared, so a
  // 0% mismatch is demonstrably over REAL escapes, not a trivial all-interior pass.
  console.log('\n== perturb floatexp — overlap band, REAL varied escapes ==');
  // The seahorse valley at 2^-70..-110: high-count chaotic escaping pixels that
  // exercise the exponent path (e ~ -70..-110). fe must match the oracle exactly
  // like df64 does. Small render (96²) keeps the heavy fe shader fast under SwiftShader.
  for (const bits of [70, 90, 110]) {
    const r = 1.5 * 2 ** -bits, it = autoIter(bits);
    const res = await page.evaluate((q) => window.__gpu.comparePerturb(q),
      { re: SH, im: SI, radius: r, maxIter: it, width: 96, height: 96, checkStep: 1, glitchTol: 0, fe: true });
    check(`fe seahorse 2^-${bits} ref=${res.refLen} esc=${res.compared - res.interiorCount}`,
          res, { inside: 8, mismFrac: 0.02, meanAbs: 1.0 });
  }

  console.log('\n== perturb floatexp — EXTREME depth below the float32 floor ==');
  // Escaping exterior patch (a point well outside the set): dc, dz ~ 2^-N sit far
  // below the float32 floor where plain df64 underflows to 0. fe must still produce
  // correct escapes. Counts are near-uniform across the tiny patch, but the full fe
  // escape + smooth-count path runs and must match the double oracle. 2^-340 is past
  // even the CPU df64's useful range yet fe holds.
  for (const bits of [130, 170, 220, 270, 340]) {
    const r = 1.5 * 2 ** -bits;
    const res = await page.evaluate((q) => window.__gpu.comparePerturb(q),
      { re: '0.36', im: '0.09', radius: r, maxIter: 1200, width: W, height: H, checkStep: 2, glitchTol: 0, fe: true });
    check(`fe exterior 2^-${bits} ref=${res.refLen} esc=${res.compared - res.interiorCount}`,
          res, { inside: 8, mismFrac: 0.02, meanAbs: 1.0 });
  }

  // ACTIVE DISPATCH ENGINE 4 — perturbation RESCALED (shared-exponent dz), same depth
  // range as floatexp but ~1.4-2.8× faster (the per-iteration update runs in raw df64
  // under one shared exponent, renormalized once, instead of per-component floatexp).
  // The escape/rebase test still runs in exact floatexp, so it must match the oracle to
  // the SAME tolerance as fe. Same seahorse-valley + below-floor-exterior cases as fe.
  console.log('\n== perturb rescaled — overlap band, REAL varied escapes ==');
  for (const bits of [70, 90, 110]) {
    const r = 1.5 * 2 ** -bits, it = autoIter(bits);
    const res = await page.evaluate((q) => window.__gpu.comparePerturb(q),
      { re: SH, im: SI, radius: r, maxIter: it, width: 96, height: 96, checkStep: 1, glitchTol: 0, rs: true });
    check(`rs seahorse 2^-${bits} ref=${res.refLen} esc=${res.compared - res.interiorCount}`,
          res, { inside: 8, mismFrac: 0.02, meanAbs: 1.0 });
  }
  console.log('\n== perturb rescaled — EXTREME depth below the float32 floor ==');
  for (const bits of [130, 170, 220, 270, 340]) {
    const r = 1.5 * 2 ** -bits;
    const res = await page.evaluate((q) => window.__gpu.comparePerturb(q),
      { re: '0.36', im: '0.09', radius: r, maxIter: 1200, width: W, height: H, checkStep: 2, glitchTol: 0, rs: true });
    check(`rs exterior 2^-${bits} ref=${res.refLen} esc=${res.compared - res.interiorCount}`,
          res, { inside: 8, mismFrac: 0.02, meanAbs: 1.0 });
  }

  await browser.close();
} catch (e) {
  console.error('ERROR:', e.stack || e);
  failed++;
} finally {
  server.kill();
}
console.log(`\n${failed ? 'FAILURES: ' + failed : 'ALL GPU VALIDATIONS PASSED'}`);
process.exit(failed ? 1 : 0);
