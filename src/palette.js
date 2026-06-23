// palette.js — map smooth iteration counts to RGB. Coloring is cheap and runs
// on the main thread from the worker's `sn` data, so palette/shift changes are
// instant without recomputing the fractal.
//
// Convention: sn === -1 (or < 0) means "inside the set" -> drawn as the interior
// color. Otherwise sn is the fractional smooth escape count.

// Smooth interpolation between gradient control points (each [r,g,b] 0..255).
function gradient(stops, t) {
  // t in [0,1), cyclic
  const n = stops.length;
  const x = (t - Math.floor(t)) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i % n];
  const b = stops[(i + 1) % n];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

// Classic Ultra-Fractal-style blue/white/orange/black cycle.
const UF = [
  [0, 7, 100], [32, 107, 203], [237, 255, 255],
  [255, 170, 0], [0, 2, 0], [0, 7, 100],
];
// Fiery
const FIRE = [
  [0, 0, 0], [120, 20, 0], [220, 90, 0], [255, 200, 40], [255, 255, 220], [120, 20, 0],
];
// Grayscale
const GRAY = [[0, 0, 0], [255, 255, 255]];
// Rainbow via HSV done analytically below (paletteId 'rainbow')

export const PALETTES = {
  ultra: { name: 'Ultra', stops: UF, interior: [0, 0, 0] },
  fire: { name: 'Fire', stops: FIRE, interior: [10, 0, 0] },
  gray: { name: 'Gray', stops: GRAY, interior: [0, 0, 0] },
  rainbow: { name: 'Rainbow', stops: null, interior: [0, 0, 0] },
};

function hsv(h, s, v) {
  h = (h % 1 + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

// One color for a smooth count. opts: { paletteId, cycle (period in iters),
// shift (0..1), interiorColor }.
export function colorFor(sn, opts) {
  if (sn < 0 || !isFinite(sn)) {
    const p = PALETTES[opts.paletteId] || PALETTES.ultra;
    return opts.interior || p.interior;
  }
  const cycle = opts.cycle || 64;
  const t = sn / cycle + (opts.shift || 0);
  if (opts.paletteId === 'rainbow') return hsv(t, 0.85, 1.0);
  const p = PALETTES[opts.paletteId] || PALETTES.ultra;
  return gradient(p.stops, t);
}

// Palette-shape color at phase u in [0,1) — the gradient/hue ignoring cycle/shift
// (the GPU color pass applies t = sn/cycle + shift then samples this LUT at
// fract(t), so the LUT must encode only the palette shape). Mirrors colorFor with
// cycle=1, shift=0, sn=u, so CPU and GPU coloring agree to LUT resolution.
export function paletteRgbAt(paletteId, u) {
  return colorFor(u, { paletteId, cycle: 1, shift: 0 });
}

// Fill an RGBA Uint8ClampedArray (full image) from an sn buffer for a region.
//   img    : Uint8ClampedArray length width*height*4 (the canvas ImageData.data)
//   sn     : Float64Array for the REGION (length region.w*region.h)
//   width  : full image width (for indexing img)
//   region : { x0, y0, w, h }
export function colorizeRegion(img, sn, width, region, opts) {
  const { x0, y0, w, h } = region;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [r, g, b] = colorFor(sn[j * w + i], opts);
      const px = x0 + i, py = y0 + j;
      const o = (py * width + px) * 4;
      img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
    }
  }
}

// Block-fill version for progressive low-res passes: each sn sample paints a
// step x step block. snW/snH are the subsampled grid dims.
export function colorizeBlocks(img, sn, width, height, snW, snH, step, opts) {
  for (let sy = 0; sy < snH; sy++) {
    for (let sx = 0; sx < snW; sx++) {
      const [r, g, b] = colorFor(sn[sy * snW + sx], opts);
      const px0 = sx * step, py0 = sy * step;
      for (let dy = 0; dy < step && py0 + dy < height; dy++) {
        for (let dx = 0; dx < step && px0 + dx < width; dx++) {
          const o = ((py0 + dy) * width + (px0 + dx)) * 4;
          img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
        }
      }
    }
  }
}
