import { test, expect } from '@playwright/test';
import { waitDone, lastDone } from './helpers.mjs';

// These run the GPU validation harness (GPU vs CPU oracle, headless via
// SwiftShader) and confirm the live app dispatches to the GPU engines. The
// exhaustive depth sweep lives in tools/validate-gpu.mjs; here we assert the
// key invariants cheaply so a regression fails CI.

test('WebGL2 is available and the GPU renderer initializes', async ({ page }) => {
  await page.goto('/test/gpu/harness.html');
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  const init = await page.evaluate(() => window.__gpu.init(120, 120));
  expect(init.ok).toBe(true);
  expect(init.supported).toBe(true);
});

test('GPU naive f32 matches the CPU naive oracle at home (bulk)', async ({ page }) => {
  await page.goto('/test/gpu/harness.html');
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await page.evaluate(() => window.__gpu.init(160, 160));
  const res = await page.evaluate(() => {
    const r = 1.5, W = 160, H = 160, scale = (2 * r) / H;
    return window.__gpu.compareNaive({ ox: -0.5 - r * (W / H), oy: 0 - r, scale, maxIter: 400, width: W, height: H, df64: false, checkStep: 1 });
  });
  // bulk agreement: mean smooth-count diff tiny, few-count mismatches rare
  expect(res.meanAbs).toBeLessThan(0.3);
  expect(res.mism / res.compared).toBeLessThan(0.02);
});

test('GPU perturb df64 matches the CPU perturbation oracle deep (2^-30, 2^-60)', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/test/gpu/harness.html');
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await page.evaluate(() => window.__gpu.init(120, 120));
  const SH = '-0.743643887037158704752191506114774', SI = '0.131825904205311970493132056385139';
  for (const [bits, it] of [[30, 8000], [60, 15000]]) {
    const res = await page.evaluate(([re, im, r, mi]) => window.__gpu.comparePerturb(
      { re, im, radius: r, maxIter: mi, width: 120, height: 120, checkStep: 2, glitchTol: 0, df64: true }),
      [SH, SI, 1.5 * 2 ** -bits, it]);
    expect(res.meanAbs).toBeLessThan(1.0);          // boundary-level only
    expect(res.mism / res.compared).toBeLessThan(0.02);
    expect(res.insideMismatch).toBeLessThan(10);
  }
});

test('app dispatches gpu-naive at home and gpu-perturb when deep', async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
  await page.goto('/');
  await waitDone(page, 0);
  expect((await lastDone(page)).engine).toBe('gpu-naive');

  // Disable supersampling for this dispatch check: it 4×'s the pixel work, which
  // is slow under SwiftShader (software GL) headless. AA quality is covered elsewhere.
  const cs = await page.evaluate(() => window.__doneCount);
  await page.evaluate(() => window.__viewer.setSupersample(1));
  await waitDone(page, cs);

  const c0 = await page.evaluate(() => window.__doneCount);
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139', radius: 5e-13, maxIter: 8000,
  }));
  await waitDone(page, c0, 45000);
  expect((await lastDone(page)).engine).toBe('gpu-perturb');
});

test('forceCpu falls back to the CPU worker engines and still renders', async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
  await page.goto('/');
  await waitDone(page, 0);
  const c0 = await page.evaluate(() => {
    const v = window.__viewer; v.forceCpu = true; v._gpuChecked = false; v.gpu = null;
    const n = window.__doneCount; v.render(); return n;
  });
  await waitDone(page, c0, 30000);
  expect((await lastDone(page)).engine).toBe('naive'); // CPU naive at home
});
