# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: gpu.spec.mjs >> GPU perturb df64 matches the CPU perturbation oracle deep (2^-30, 2^-60)
- Location: test/e2e/gpu.spec.mjs:30:1

# Error details

```
Error: expect(received).toBeLessThan(expected)

Expected: < 1
Received:   43.945297818409834
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { waitDone, lastDone } from './helpers.mjs';
  3  | 
  4  | // These run the GPU validation harness (GPU vs CPU oracle, headless via
  5  | // SwiftShader) and confirm the live app dispatches to the GPU engines. The
  6  | // exhaustive depth sweep lives in tools/validate-gpu.mjs; here we assert the
  7  | // key invariants cheaply so a regression fails CI.
  8  | 
  9  | test('WebGL2 is available and the GPU renderer initializes', async ({ page }) => {
  10 |   await page.goto('/test/gpu/harness.html');
  11 |   await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  12 |   const init = await page.evaluate(() => window.__gpu.init(120, 120));
  13 |   expect(init.ok).toBe(true);
  14 |   expect(init.supported).toBe(true);
  15 | });
  16 | 
  17 | test('GPU naive f32 matches the CPU naive oracle at home (bulk)', async ({ page }) => {
  18 |   await page.goto('/test/gpu/harness.html');
  19 |   await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  20 |   await page.evaluate(() => window.__gpu.init(160, 160));
  21 |   const res = await page.evaluate(() => {
  22 |     const r = 1.5, W = 160, H = 160, scale = (2 * r) / H;
  23 |     return window.__gpu.compareNaive({ ox: -0.5 - r * (W / H), oy: 0 - r, scale, maxIter: 400, width: W, height: H, df64: false, checkStep: 1 });
  24 |   });
  25 |   // bulk agreement: mean smooth-count diff tiny, few-count mismatches rare
  26 |   expect(res.meanAbs).toBeLessThan(0.3);
  27 |   expect(res.mism / res.compared).toBeLessThan(0.02);
  28 | });
  29 | 
  30 | test('GPU perturb df64 matches the CPU perturbation oracle deep (2^-30, 2^-60)', async ({ page }) => {
  31 |   test.setTimeout(60000);
  32 |   await page.goto('/test/gpu/harness.html');
  33 |   await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  34 |   await page.evaluate(() => window.__gpu.init(120, 120));
  35 |   const SH = '-0.743643887037158704752191506114774', SI = '0.131825904205311970493132056385139';
  36 |   for (const [bits, it] of [[30, 8000], [60, 15000]]) {
  37 |     const res = await page.evaluate(([re, im, r, mi]) => window.__gpu.comparePerturb(
  38 |       { re, im, radius: r, maxIter: mi, width: 120, height: 120, checkStep: 2, glitchTol: 0, df64: true }),
  39 |       [SH, SI, 1.5 * 2 ** -bits, it]);
> 40 |     expect(res.meanAbs).toBeLessThan(1.0);          // boundary-level only
     |                         ^ Error: expect(received).toBeLessThan(expected)
  41 |     expect(res.mism / res.compared).toBeLessThan(0.02);
  42 |     expect(res.insideMismatch).toBeLessThan(10);
  43 |   }
  44 | });
  45 | 
  46 | test('app dispatches gpu-naive at home and gpu-perturb when deep', async ({ page }) => {
  47 |   page.on('pageerror', (e) => { throw e; });
  48 |   await page.goto('/');
  49 |   await waitDone(page, 0);
  50 |   expect((await lastDone(page)).engine).toBe('gpu-naive');
  51 | 
  52 |   // Disable supersampling for this dispatch check: it 4×'s the pixel work, which
  53 |   // is slow under SwiftShader (software GL) headless. AA quality is covered elsewhere.
  54 |   const cs = await page.evaluate(() => window.__doneCount);
  55 |   await page.evaluate(() => window.__viewer.setSupersample(1));
  56 |   await waitDone(page, cs);
  57 | 
  58 |   const c0 = await page.evaluate(() => window.__doneCount);
  59 |   await page.evaluate(() => window.__viewer.setState({
  60 |     cx: '-0.743643887037158704752191506114774',
  61 |     cy: '0.131825904205311970493132056385139', radius: 5e-13, maxIter: 8000,
  62 |   }));
  63 |   await waitDone(page, c0, 45000);
  64 |   expect((await lastDone(page)).engine).toBe('gpu-perturb');
  65 | });
  66 | 
  67 | test('forceCpu falls back to the CPU worker engines and still renders', async ({ page }) => {
  68 |   page.on('pageerror', (e) => { throw e; });
  69 |   await page.goto('/');
  70 |   await waitDone(page, 0);
  71 |   const c0 = await page.evaluate(() => {
  72 |     const v = window.__viewer; v.forceCpu = true; v._gpuChecked = false; v.gpu = null;
  73 |     const n = window.__doneCount; v.render(); return n;
  74 |   });
  75 |   await waitDone(page, c0, 30000);
  76 |   expect((await lastDone(page)).engine).toBe('naive'); // CPU naive at home
  77 | });
  78 | 
```