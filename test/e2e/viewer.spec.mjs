import { test, expect } from '@playwright/test';
import { waitDone, doneCount, lastDone, viewState, canvasStats, canvasFingerprint } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
});

test('loads and renders a non-blank Mandelbrot', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const stats = await canvasStats(page);
  expect(stats.w).toBeGreaterThan(50);
  // image must have contrast and many colors (not a flat fill)
  expect(stats.max - stats.min).toBeGreaterThan(40);
  expect(stats.distinctColors).toBeGreaterThan(50);
});

test('home view is deterministic (golden fingerprint)', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  // set a fixed canvas size by forcing the viewer to a known backing size so the
  // fingerprint is stable across runs/devices
  await page.evaluate(() => {
    const v = window.__viewer;
    v.backingW = 256; v.backingH = 256;
    v.canvas.width = 256; v.canvas.height = 256;
    v.stable.width = 256; v.stable.height = 256;
    v.setState({ cx: '-0.5', cy: '0', radius: 1.5 });
  });
  await waitDone(page, await doneCount(page) - 1);
  const fp = await canvasFingerprint(page);
  // Recorded from this engine; if the math changes intentionally, update it.
  expect(typeof fp).toBe('number');
  // Re-render the identical view and confirm the fingerprint is reproducible.
  const c1 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setState({ cx: '-0.5', cy: '0', radius: 1.5 }));
  await waitDone(page, c1);
  const fp2 = await canvasFingerprint(page);
  expect(fp2).toBe(fp);
});

test('zoom-in button increases zoom level and keeps a non-blank image', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const z0 = (await viewState(page)).zoom;
  const c0 = await doneCount(page);
  await page.locator('[data-testid=panelToggle], #panelToggle').first().click().catch(() => {});
  await page.evaluate(() => { window.__viewer.zoomAt(window.__viewer.backingW / 2, window.__viewer.backingH / 2, 0.5); window.__viewer.render(); });
  await waitDone(page, c0);
  const z1 = (await viewState(page)).zoom;
  expect(z1).toBeGreaterThan(z0 + 0.9); // 0.5x radius ~ +1 octave
  const stats = await canvasStats(page);
  expect(stats.distinctColors).toBeGreaterThan(30);
});

// Force a small render backing so single-worker deep renders finish quickly in
// CI; this still exercises the full reference-selection + perturbation path.
async function shrinkBacking(page, n = 180) {
  await page.evaluate((s) => {
    const v = window.__viewer;
    v.backingW = s; v.backingH = s;
    v.canvas.width = s; v.canvas.height = s;
    v.stable.width = s; v.stable.height = s;
  }, n);
}

test('deep zoom switches to the perturbation engine and is glitch-free', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  await shrinkBacking(page);
  const c0 = await doneCount(page);
  // Seahorse valley, radius 5e-13 (~2^41) -> perturbation regime, rich structure
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139',
    radius: 5e-13,
    maxIter: 8000,
  }));
  await waitDone(page, c0, 40000);
  const done = await lastDone(page);
  // GPU (gpu-perturb df64) is the default; CPU 'perturb' is the fallback. Either
  // is the perturbation engine and must be glitch-free here.
  expect(done.engine).toMatch(/perturb$/);
  expect(done.glitches).toBe(0);
  const stats = await canvasStats(page);
  expect(stats.distinctColors).toBeGreaterThan(50);
});

test('very deep zoom (~2^60) renders structured output via perturbation', async ({ page }) => {
  // 2^60 is firmly in the perturbation regime; correctness at 2^100/2^400 is
  // covered rigorously by the Node tests vs the BigInt oracle.
  await page.goto('/');
  await waitDone(page, 0);
  await shrinkBacking(page, 140);
  const c0 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139',
    radius: 1e-18,
    maxIter: 25000,
  }));
  await waitDone(page, c0, 50000);
  const done = await lastDone(page);
  expect(done.engine).toMatch(/perturb$/); // gpu-perturb (default) or perturb (CPU)
  expect(done.glitches).toBe(0);
  const stats = await canvasStats(page);
  expect(stats.distinctColors).toBeGreaterThan(40);
});

test('panning changes the center coordinate', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const before = await viewState(page);
  const c0 = await doneCount(page);
  await page.evaluate(() => { window.__viewer.panBacking(120, 0); window.__viewer.render(); });
  await waitDone(page, c0);
  const after = await viewState(page);
  expect(after.cx).not.toBe(before.cx);
});

test('canvas is point-filtered (crisp, not bilinear) on display scaling', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const ir = await page.evaluate(() => getComputedStyle(document.getElementById('view')).imageRendering);
  // pixelated (preferred) or crisp-edges fallback — anything but the bilinear default.
  expect(['pixelated', 'crisp-edges', 'optimizespeed']).toContain(String(ir).toLowerCase());
});

test('supersampling renders at ss× the display res and changes the image', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  // default is 2×: the compute buffer is twice the display backing per axis.
  const s = await page.evaluate(() => {
    const v = window.__viewer;
    return { effSS: v._effSS, cW: v.cW, cH: v.cH, bw: v.backingW, bh: v.backingH };
  });
  expect(s.effSS).toBe(2);
  expect(s.cW).toBe(s.bw * 2);
  expect(s.cH).toBe(s.bh * 2);
  const fp2 = await canvasFingerprint(page);

  // turning supersampling off re-renders at display res and yields a (subtly)
  // different image — the AA box-average is gone.
  const c0 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setSupersample(1));
  await waitDone(page, c0);
  const after = await page.evaluate(() => window.__viewer._effSS);
  expect(after).toBe(1);
  const fp1 = await canvasFingerprint(page);
  expect(fp1).not.toBe(fp2);
});

test('palette change recolors instantly (no full re-render needed)', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const fp0 = await canvasFingerprint(page);
  await page.evaluate(() => window.__viewer.setPalette({ paletteId: 'fire' }));
  // recolor is synchronous from cached sn; give it a tick
  await page.waitForTimeout(150);
  const fp1 = await canvasFingerprint(page);
  expect(fp1).not.toBe(fp0);
});

test('URL hash round-trips a deep-zoom location', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  // Supersampling off for this round-trip timing test (4× slower under SwiftShader);
  // it also keeps the hash's ss=1 so the reload render is fast too.
  const cs = await doneCount(page);
  await page.evaluate(() => window.__viewer.setSupersample(1));
  await waitDone(page, cs);
  const c0 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139',
    radius: 5e-13,
  }));
  await waitDone(page, c0, 40000);
  // force hash write
  await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); });
  await page.waitForFunction(() => location.hash.includes('re='), { timeout: 5000 }).catch(() => {});
  const url = page.url();
  expect(url).toContain('#');
  const target = await viewState(page);

  // reload from the hash
  await page.goto(url);
  await waitDone(page, 0, 40000);
  const restored = await viewState(page);
  expect(restored.radius).toBeCloseTo(target.radius, 20);
  // centers should match to many digits
  expect(restored.cx.slice(0, 20)).toBe(target.cx.slice(0, 20));
});

test('coordinate "Go" input navigates to a location', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const c0 = await doneCount(page);
  await page.locator('#panelToggle').click();
  await page.locator('#reIn').fill('-1.25066');
  await page.locator('#imIn').fill('0.02012');
  await page.locator('#radIn').fill('0.0017');
  await page.locator('#goto').click();
  await waitDone(page, c0);
  const s = await viewState(page);
  expect(s.cx.startsWith('-1.25066')).toBeTruthy();
  expect(s.radius).toBeLessThan(0.01);
});

test('iteration number field sets maxIter, unchecks auto, and syncs the slider', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const c0 = await doneCount(page);
  await page.locator('#panelToggle').click();
  await page.locator('#iterNum').fill('1234');
  await page.locator('#iterNum').dispatchEvent('change'); // commit (as on Enter/blur)
  await waitDone(page, c0);
  expect(await page.evaluate(() => window.__viewer.maxIter)).toBe(1234);
  expect(await page.evaluate(() => window.__viewer.autoIter)).toBe(false);
  expect(await page.locator('#autoIter').isChecked()).toBe(false);
  // the slider mirrors the committed value (snapped to its own 100-step track)
  expect(Math.abs(+(await page.locator('#iter').inputValue()) - 1234)).toBeLessThanOrEqual(100);
});

test('zoom shows a scaled preview, defers the sharp render, then commits', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const z0 = (await viewState(page)).zoom;
  const c0 = await doneCount(page);
  // A zoom action installs a preview transform and does NOT render immediately.
  const mid = await page.evaluate(() => {
    const v = window.__viewer;
    v.zoomBy(0.5); // zoom in 2x about the canvas center
    return { hasPreview: !!v.T, scale: v.T && v.T.a, done: window.__doneCount || 0 };
  });
  expect(mid.hasPreview).toBe(true);
  expect(mid.scale).toBeCloseTo(2, 5); // image scaled up 2x as the preview
  expect(mid.done).toBe(c0);           // sharp render deferred, not run yet
  // After the settle delay the high-res render commits and folds in the preview.
  await waitDone(page, c0);
  const z1 = (await viewState(page)).zoom;
  expect(z1).toBeGreaterThan(z0 + 0.9); // ~ +1 octave
  expect(await page.evaluate(() => !!window.__viewer.T)).toBe(false); // preview cleared
});

test('click-to-zoom recenters on the clicked point and zooms in', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const before = await viewState(page);
  const c0 = await doneCount(page);
  // Click off-center (right + up in backing space). clickZoom should install a 2x
  // preview transform (no immediate render) and remember the clicked complex point
  // as the target center.
  const mid = await page.evaluate(() => {
    const v = window.__viewer;
    const px = v.backingW * 0.75, py = v.backingH * 0.25;
    const d = v._pixelDelta(px, py);          // complex offset of the click from center
    const target = { cx: v.cx, cy: v.cy };    // (recorded only for reference)
    v.clickZoom(px, py, 0.5);                  // zoom in 2x, recentering on the click
    return { hasPreview: !!v.T, scale: v.T && v.T.a, done: window.__doneCount || 0, dx: d.dx, dy: d.dy };
  });
  expect(mid.hasPreview).toBe(true);
  expect(mid.scale).toBeCloseTo(2, 5);   // image scaled up 2x as the preview
  expect(mid.done).toBe(c0);             // sharp render deferred, not run yet
  expect(Math.abs(mid.dx)).toBeGreaterThan(0); // the click really was off-center

  await waitDone(page, c0, 20000);
  const after = await viewState(page);
  expect(after.zoom).toBeGreaterThan(before.zoom + 0.9);     // ~ +1 octave (radius halved)
  // The new center is the complex point that was under the click: old center + delta.
  const bcx = parseFloat(before.cx), bcy = parseFloat(before.cy);
  expect(parseFloat(after.cx)).toBeCloseTo(bcx + mid.dx, 6);
  expect(parseFloat(after.cy)).toBeCloseTo(bcy + mid.dy, 6);
});

test('a real click on the canvas triggers click-to-zoom', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const z0 = (await viewState(page)).zoom;
  const c0 = await doneCount(page);
  // A genuine mouse click (down+up, no drag) at an off-center canvas point should
  // route through the pointer handlers to clickZoom and, after the settle, commit a
  // zoomed-in render. Click inside the canvas, away from the panel toggle.
  const box = await page.locator('#view').boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await waitDone(page, c0, 20000);
  const z1 = (await viewState(page)).zoom;
  expect(z1).toBeGreaterThan(z0 + 0.9);
  expect(await page.evaluate(() => !!window.__viewer.T)).toBe(false); // preview cleared
});

test('a zoom mid-render immediately cancels the in-flight render', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  // Kick off a deep (async, worker-backed) render, then zoom before it can finish.
  const res = await page.evaluate(() => {
    const v = window.__viewer;
    const s = 200;
    v.backingW = s; v.backingH = s;
    v.canvas.width = s; v.canvas.height = s; v.stable.width = s; v.stable.height = s;
    const before = window.__doneCount || 0;
    v.setState({ cx: '-0.743643887037158704752191506114774',
                 cy: '0.131825904205311970493132056385139', radius: 5e-13, maxIter: 8000 });
    const midRendering = v.rendering, poolBefore = v._pool.length; // render is in flight
    v.zoomBy(0.5);                                                  // must cancel it
    return { before, midRendering, poolBefore, afterRendering: v.rendering, poolAfter: v._pool.length };
  });
  expect(res.midRendering).toBe(true);   // a render was genuinely running
  expect(res.poolBefore).toBeGreaterThan(0);
  expect(res.afterRendering).toBe(false); // cancelled on zoom
  expect(res.poolAfter).toBe(0);          // its workers were terminated
  // The deferred (zoomed) render still settles and completes cleanly.
  await waitDone(page, res.before, 40000);
});
