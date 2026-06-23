# NOTES — architecture, math, decisions

Read this first. It is how each spawn talks to the next.

## The core idea (perturbation theory)

Mandelbrot iteration: z_{n+1} = z_n^2 + c, escapes when |z|>2.

Naive double precision dies around zoom 2^50 (53-bit mantissa). To reach 2^400 we
use **perturbation theory**:

- Pick a reference point C (the view center) and compute its orbit Z_n in HIGH
  precision (BigInt fixed-point). Z_n values are O(1) magnitude.
- For a nearby pixel c = C + dc (dc tiny), write its orbit as z_n = Z_n + dz_n.
  Subtracting the reference iteration gives the **delta iteration**:

      dz_{n+1} = 2 * Z_n * dz_n + dz_n^2 + dc

- This delta iteration runs in DOUBLE precision. Why doubles suffice for 2^400:
  double's *exponent* reaches 2^-1022, so dc ~ 2^-400 and dz ~ 2^-400 are stored
  with full 53-bit *relative* precision. We only lose precision near 2^-1000 zoom.
  So **doubles are correct to ~2^1000 zoom; 2^400 is comfortably inside.**
  Only the *reference center coordinate* needs high precision (it has ~400
  significant bits); every per-pixel quantity (dc, dz) is a normal double.

## Glitch handling — Zhuoran rebasing (primary)

Single-reference perturbation glitches when the true orbit point z_n = Z_n + dz_n
is much smaller than the reference Z_n (catastrophic cancellation: dz loses
meaning). The robust modern fix is **rebasing** (Zhuoran, fractalforums 2021):

  track reference index m and dz; the true value is z = Z_m + dz.
  each step: dz = 2*Z_m*dz + dz^2 + dc;  m += 1
  let z = Z_m + dz  (true orbit value)
  REBASE: if |z| < |dz|  (equivalently |Z_m + dz| < |dz|), then
      dz = z;  m = 0
  escape test uses |z| (the TRUE value), not |dz|.

Rebasing with Z_0 = 0 means "restart the delta against the beginning of the
reference orbit" using the true value as the new delta — glitch-free with ONE
reference. We also keep a Pauldelbrot-style check (|z|^2 < 1e-6 * |Z_m|^2) as an
independent diagnostic / test assertion, but rebasing is what we render with.

Reference must be long enough: if a pixel needs iteration k but the reference
escaped/ended at m<k, extend the reference or, after rebasing, m wraps to 0 and we
keep going up to that pixel's maxIter. We compute the reference to maxIter and, if
it escapes early, we still keep Z_n for n up to escape (Z stays defined; for the
classic "Z_0=0" reference of the center, if the *center* escapes the location is
outside the set anyway).

## Validation strategy (against ground truth)

`naive.js` is the ORACLE: plain-double escape-time Mandelbrot. At shallow zoom
(<= ~2^40) it is exact. Every higher layer is validated against it:

1. bignum complex mul/sqr vs known products & vs JS Number at low precision.
2. reference orbit (high precision) vs naive double orbit at shallow zoom -> equal.
3. **perturbation per-pixel escape counts == naive per-pixel counts** over a grid
   at shallow zoom. This is the make-or-break test (M4). If perturbation matches
   the oracle exactly where the oracle is valid, the engine is correct; we then
   trust it where the oracle can't reach (deep zoom).
4. Deep-zoom smoke tests assert "no glitch pixels" via the Pauldelbrot diagnostic
   and visual/structural checks.

## High precision: fixed-point BigInt

A real value v is stored as a BigInt `m` with v = m / 2^PREC (two's-complement
sign via BigInt sign). PREC ~ zoomBits + 64 guard bits.
- add/sub: BigInt +/- .
- mul: (a*b) then arithmetic shift right by PREC (with round-to-nearest).
- We only need: complex add, complex sqr (for z^2), complex mul, magnitude
  compare vs 4 (escape), and toDouble for export.
Reference orbit needs ~maxIter such iterations; done in a Web Worker with
progress. PREC chosen from view radius: PREC = ceil(-log2(radius)) + 64.

## Why CPU-first, GPU-later

- CPU double perturbation in Web Workers is *correct* to 2^400 and easy to
  validate against the oracle. It is the foundation.
- GPU float32 CANNOT represent 2^-400 deltas (min normal ~2^-126). Deep-zoom GPU
  needs scaled deltas + per-pixel rescale ("floatexp") or double-emulation — more
  complex and harder to validate. So GPU is M6, an accelerator, not the base.
- Mobile: progressive low-res-first + tiling + workers keeps it interactive even
  on CPU. GPU added later for shallow/medium zoom speed.

## Module layout
- src/math/naive.js      — oracle escape-time (doubles)         [pure, Node+browser]
- src/math/bignum.js     — fixed-point BigInt real/complex      [pure]
- src/math/reference.js  — high-precision reference orbit        [pure]
- src/math/perturb.js    — delta iteration + rebasing            [pure]
- src/math/palette.js    — smooth coloring                       [pure]
- src/worker.js          — pool worker: 'computeRef' (once) + 'render' bands
- src/math/render.js     — reference auto-selection + renderImage + dispatch
- src/viewer.js          — canvas, view state, touch/zoom, render orchestration
- src/main.js            — UI wiring (sliders, readouts, URL hash)
- index.html, styles.css
- test/unit/*.mjs        — Node test runner (node --test)
- test/e2e/*.spec.mjs    — Playwright
- tools/serve.mjs        — static server for dev + e2e

Pure math modules must import-cleanly in BOTH Node (tests) and the browser
(workers), so: no DOM, no top-level await, plain ESM exports.

## View-state representation
- center: {x: BigInt, y: BigInt, prec: PREC}  (high precision)
- radius (half-height of view in complex plane): a Number (double) — fine since
  >= ~2^-1000. zoom "level" displayed as log2(baseRadius/radius).
- maxIter: Number, auto-scaled with depth.
- For shallow zoom the high-precision center still works (PREC just small).

## Zoom / gesture interaction model (viewer.js) — read before touching gestures

The render is expensive (workers / GPU draw); the rule is **never re-render while
the user is still moving the view**. Instead we transform the last good frame.

- `this.T = {a, e, f}` is a preview transform in backing-pixel space:
  displayed = a*orig + (e,f). `_applyPreview()` draws the snapshot `this.stable`
  under that transform (smooth-scaled). While `T` is set, a preview is "active".
- `_beginPreview()` (idempotent — acts only when `T` is null) is the single entry
  to a gesture: it snapshots the *current visible frame* into `this.stable`
  (so even a half-finished render is what we scale), sets `T = identity`, and
  **cancels any in-flight render** (`gen++` to invalidate stale worker messages +
  `_terminatePool()` + `rendering=false`).
- Two ways a preview commits to a real render:
  - touch drag/pinch: `pointerup` with no pointers left → `_endGesture()` (immediate).
  - momentum-free sources (wheel / zoom buttons / click-to-zoom) have no "up", so
    `_scheduleSettle()` debounces `_endGesture()` ~220ms after the last motion.
  `_endGesture()` folds `T` into the HP view state (new center + radius/=T.a),
  clears `T`, and calls `render()`. `render()` also `_clearSettle()`s.
- `zoomBy(factor, px, py)` is the shared zoom primitive (radius *= factor about a
  backing pixel, **kept fixed**): `_beginPreview()` → compose scale `s=1/factor`
  about (px,py) into `T` → `_applyPreview()` → `_scheduleSettle()`. Wheel + the +/-
  buttons call it. `zoomAt()` (mutates view state directly, no preview) still
  exists for tests and programmatic jumps.
- `clickZoom(px, py, factor)` is the **click-to-zoom** primitive (added Spawn 5):
  like zoomBy but it RECENTERS — the clicked complex point becomes the new view
  center (moves to screen middle) AND radius *= factor. The displayed-space op is
  "scale by s=1/factor about (px,py), then translate (px,py)→center"; composed
  G∘T so it stacks with any in-progress preview, and `_endGesture` folds it in
  (new center = complex point under the click, new radius = radius*factor — verified
  by the e2e). A plain tap / left-click (down→up, no drag) calls it with factor=0.5
  (zoom in); shift / ctrl / right-click use factor=2 (zoom out). Right-click's
  context menu is suppressed on the canvas. (There is no more double-tap handler —
  a single tap now zooms, so two taps just zoom twice.)
- IMPORTANT subtlety: a pan/pinch preview begins **lazily on the first real move**,
  NOT on pointerdown. A plain tap (down→up, <1px move) must not cancel a running
  render — instead, on `pointerup` with `T` still null, it is treated as a click and
  routed to `clickZoom`. (The old `_beginGesture()` cancelled on every pointerdown,
  which also made a deep double-tap terminate its own freshly-kicked render.)

## Decisions / dead-ends log

### Engine dispatch by depth (IMPORTANT, validated empirically)
Double-precision perturbation stores the reference orbit as doubles (Z_n ~ O(1),
53-bit). At SHALLOW zoom (radius ~0.02) dc is large, so the per-pixel delta dz
grows to O(1) within a few iterations and the whole computation is only ~53-bit —
i.e. NO better than naive there. On ultra-sensitive boundary pixels (near
Misiurewicz points, high escape counts) double perturbation is then off by tens
of iterations and can even misclassify inside/outside. Measured at radius 0.02,
maxIter 1500: ~5/6400 pixels wrong, one inside-point reported as escaped.

At DEEP zoom dc ~ 2^-N is tiny, dz stays tiny far longer, so effective precision
is much higher and perturbation matches the BigInt-exact oracle to +/-1 (verified
by tests B/C/E at 2^45, 2^120, and a rebasing case). This is the regime
perturbation exists for.

DECISION: render NAIVE doubles for radius >= ~2^-40 (fast, GPU-able, standard,
as accurate as any double method there) and PERTURBATION for radius < ~2^-40.
They are NOT required to agree bit-for-bit on ill-conditioned shallow boundary
pixels — the BigInt orbit is the only true oracle there, and any 53-bit method
(naive OR perturbation) is noisy on that measure-zero set. See render.js
engineForRadius().

### BigInt reference precision / guard bits
precForRadius(radius, guard=64) sets prec = zoomBits + guard. For the EXACT
single-point BigInt oracle near sensitive boundary points, guard=64 was not
always enough (a point at radius 0.02 needed prec ~150 to converge its exact
count). For the perturbation *reference* (stored as double anyway) guard=64 is
fine in the deep regime (B/C/E pass). The exact-oracle tests use a generous prec.

### Validate against BigInt, not naive
naive is only an oracle where double is reliable (low/medium escape counts, not
ultra-sensitive boundary). The authoritative oracle is escapeBigInt (full BigInt,
high prec). All strict correctness assertions compare perturbation to BigInt.

## Running a browser in THIS sandbox (NixOS) — load-bearing, read before e2e
The Playwright-downloaded chromium (build 1228 in ~/.cache/ms-playwright) CANNOT
run here: it's a generic ELF whose interpreter /lib64/ld-linux-x86-64.so.2 does
not exist on NixOS -> spawn ENOENT. Fix: use a nix-store chromium instead.
- playwright.config.mjs resolves /nix/store/*-chromium-*/bin/chromium at load.
- Use the NEWEST build (148): older ones (143) crash with SIGTRAP because this
  sandbox has NO /sys/devices/system/cpu (Chromium reads it at startup). 148
  tolerates it; 143 does not.
- Must use NEW headless: pass '--headless=new' (appended after Playwright's own
  '--headless', last-wins). Old headless crashes. Also: --no-sandbox,
  --disable-dev-shm-usage, --disable-gpu, --enable-unsafe-swiftshader.
- Port 8080 is often busy on this host; default is now 8137. Override with PORT=.
- Verify a browser manually:  /nix/store/<...>-chromium-148*/bin/chromium \
    --headless=new --no-sandbox --remote-debugging-port=9333 about:blank &
  then curl http://127.0.0.1:9333/json/version
- Playwright 1.61.0 is pinned (its bundled build == cached 1228). Using nix
  chromium 148 over CDP 1.3 works fine despite the version skew.

## How to run
- `npm install`            (installs Playwright 1.61.0)
- `npm test`               (31 Node unit tests — the correctness oracle suite)
- `npm run serve`          (static server on :8137, COOP/COEP set)
- `npm run e2e`            (Playwright suite, mobile + desktop projects; SwiftShader)
- ANY tool/test takes `GPU=1` (real GPU, Vulkan) or `GPU=gl` (native GLES) — see the
  "⚠️ REAL-GPU TESTING" section. npm shortcuts: `validate:gpu:real`, `bench:gpu:real`,
  `e2e:gpu`, `probe:gpu` (flag-combo sweep), `probe:df64` (df64-precision-on-GPU gate),
  `probe:ftz`, `probe:xbackend` (GPU-df64 vs SwiftShader-df64).
- `node tools/probe-gpu-real.mjs` (which Chromium flags actually get the real GPU)
- `node tools/probe-df64.mjs` (is df64 intact on the backend, or collapsed to f32? + the
                            barrier A/B/C comparison that found the working XOR barrier)
- `node tools/probe-df64-real.mjs` (test the SHIPPING DF64_LIB: single ds_mul, a 40-iter
                            update, add-tiny-to-O(1) — all intact on GPU in isolation)
- `node tools/probe-xbackend.mjs` (render df64 on SwiftShader AND GPU, compare — shows the
                            full-shader divergence the per-op barrier doesn't fix yet)
- `node tools/probe-ftz.mjs` (does the backend flush subnormals? both do — ruled out as cause)
- `npm run validate:gpu`   (GPU-vs-oracle regression across depths — run after any
                            shader change; mismatch numbers are the correctness gate.
                            Covers naive/df64/floatexp AND rescaled. SwiftShader by default;
                            `validate:gpu:real` runs it on the real GPU — currently 12 FAIL
                            there, all deep df64/fe/rs, due to the reassociation bug.)
- `node tools/bench-gpu.mjs` (time floatexp vs rescaled perturb on this host's GL)
- `node tools/crosscheck-skip.mjs` (prove the perturb fast-skip is bit-identical:
                            renders each view with the skip on AND off → 0-diff)
- `node tools/crosscheck-tiled.mjs` (prove the strip-tiled deep render is bit-identical
                            to a single full-frame draw → 0-diff; the gate for the 2^218 fix)
- `node tools/probe-rescaled.mjs` (rescaled engine: vs the CPU oracle + vs floatexp)
- `node tools/probe-deep218.mjs` (measure deep chaotic GPU-vs-oracle mism at 2^-90..-271
                            on a real deep coordinate — showed it's 0.000%, i.e. the 2^218
                            wall was the watchdog, NOT precision)
- `node tools/shoot-deep.mjs` (render the actual viewer at the deep ultra coordinate)
- `node tools/shoot.mjs`   (capture screenshots/ — needs server running)

## ⚠️ REAL-GPU TESTING + the df64 reassociation bug (Spawn 8) — READ THIS

**Headline: the deep GPU engines (df64 / floatexp / rescaled) are NUMERICALLY WRONG on
real NVIDIA hardware. Every prior spawn validated only on SwiftShader (a CPU GL), which
HID it.** A real user on a real GPU gets 20–99% wrong pixels at deep zoom (≥ ~2^-12). The
CPU path is correct; the GPU deep path is not (yet).

### 1. How to run on the real GPU (the original ask — SOLVED)
Headless Chromium defaults to the **SwiftShader CPU rasterizer** for WebGL even when a
GPU is present; our launch flags `--disable-gpu --enable-unsafe-swiftshader` forced it.
To use the real GPU you must select an ANGLE GPU backend. All launchers now read the
`GPU` env var via the shared **tools/chromium-launch.mjs**:
- `GPU` unset / `0` / `cpu` → SwiftShader (portable default; CI-safe).
- `GPU=1` (or `vulkan`) → ANGLE/Vulkan → `ANGLE (NVIDIA, Vulkan … RTX 3090, NVIDIA)`.
- `GPU=gl` → ANGLE native GLES → `ANGLE (NVIDIA, RTX 3090, OpenGL ES 3.2)`.
Both expose EXT_color_buffer_float (RGBA32F) + maxTex 32768. Verified on RTX 3090, NVIDIA
580.82.09, headless (no X). `node tools/probe-gpu-real.mjs` is the flag-combo sweep that
found these. npm: `validate:gpu:real`, `bench:gpu:real`, `e2e:gpu`, `probe:gpu`.
The GPU is ~600× faster than SwiftShader (fe ~13000 vs ~21 Mit-px/s before the precision
barrier; the barrier costs ~2.6× because the collapsed shader was doing less work).

### 2. THE BUG: df64 collapses to float32 on NVIDIA (compiler FP reassociation)
The double-single (df64) ops in DF64_LIB depend on EXACT IEEE-754 float32 and the
Dekker/Veltkamp error terms (e.g. the split `a_hi = ca - (ca - x)`). The NVIDIA shader
compiler applies the algebraically-valid-but-FP-INVALID identity `ca - (ca - x) → x`,
which zeroes the split (`a_lo == 0`) → df64 silently degrades to plain float32 (~24-bit).
SwiftShader does NOT reassociate, so it passed there. PROVEN by tools/probe-df64.mjs:
on the real GPU `split_lo == 0` and ds_mul relerr == plain-f32; on SwiftShader it's intact.
(The reference URL Danielle gave serves byte-identical code, so it has the same bug — it
shows the target image but also falls back to CPU. This is genuinely unsolved upstream.)

### 3. The PARTIAL fix (shipped) and its LIMIT
GLSL ES 3.00 (WebGL2) has no `precise` qualifier (3.20+) and no `fma`. The portable
defense is an OPTIMIZATION BARRIER `ob(x) = intBitsToFloat(floatBitsToInt(x) ^ uOptBarrier)`
where uOptBarrier is a uniform == 0 the compiler can't prove is zero (a plain
intBitsToFloat(floatBitsToInt(x)) round-trip is FOLDED AWAY — proven). ds_add/ds_mul in
DF64_LIB now wrap every rounded result in ob(); the renderer sets uOptBarrier=0 once per
program in `_program()`. RESULT (tools/probe-df64.mjs, probe-df64-real.mjs): in ISOLATION
the barriered ds_mul / ds_add / a 40-iter update are now INTACT on the real GPU (relerr
~1e-14, == SwiftShader). **BUT** the full `perturbFragDf64` shader STILL diverges from
SwiftShader-df64 by 21% (2^-22) … 90% (2^-50) — see tools/probe-xbackend.mjs — and still
fails validate:gpu:real (df64/fe/rs FAIL 2^-3…2^-90; only the fast-escaping exterior and
naive-f32 pass). So the barrier is NECESSARY but NOT SUFFICIENT.

### 4. What the residual is NOT, and what it IS (diagnosis, for next-spawn)
Ruled OUT (all tested): isolated ds_mul/ds_add (intact), the fast-skip branch (identical
on/off), subnormal flush / FTZ (tools/probe-ftz.mjs: SwiftShader AND NVIDIA both flush —
identical, so not the differentiator), the reference texture / coordinate mapping
(identical JS upload; the divergence GROWS with iteration count, so it's per-iter
accumulation not a fixed offset). Native GLES fails IDENTICALLY to Vulkan (same numbers to
the digit) — both ANGLE frontends feed the same NVIDIA driver backend. CONCLUSION: floating
point is deterministic, so identical GLSL + identical isolated ops + divergent full-shader
output ⇒ **the NVIDIA driver compiler reassociates/contracts the LARGE inlined perturbation
shader differently than SwiftShader, past the per-op ob() barriers** (it re-optimizes after
inlining ds_* into the big main()). The simple probe shaders don't trigger it; the complex
one does. df64-vs-f32 on GPU is ~5% (not 0), so it's PARTIAL collapse, not full.

### 5. NEXT STEPS (priority)
a. **SHIP A SAFETY NET regardless of the shader fix: a GPU deep-precision self-test +
   CPU fallback.** At first deep render, render a small known tile on the GPU and compare
   escape counts to the CPU oracle (escapePerturb is in the browser already); if mism >
   tol, mark the GPU deep path untrusted and route deep renders to the CPU pool (correct,
   just slower). This makes the viewer CORRECT on ALL hardware today — a real user-facing
   bug fix — independent of cracking the shader. THE highest-value next action.
b. Crack the residual: needs NVIDIA ISA introspection (no easy tool in-sandbox). Ideas to
   try: (i) a stronger/un-CSE-able barrier (the per-op ob() survives simple shaders but the
   driver defeats it in the big one — try barriering at the shader-body composition level
   too, or a barrier whose value the driver can't hoist); (ii) split perturbFragDf64 so the
   compiler has less to reassociate; (iii) test whether a TRIPLE-float or a higher-precision
   reference changes it (if it's a true precision cliff after all — but the GPU-vs-SwiftShader
   divergence of identical code argues compiler, not cliff). Re-run validate:gpu:real after
   each idea — it's the gate. probe-xbackend.mjs (GPU-df64 vs SwiftShader-df64) is the fast
   inner-loop signal (no oracle needed; should drop toward ~0%).
c. Once correct on GPU: profile (bench:gpu:real shows rescaled ~2.1× faster than fe on real
   HW vs 1.26× on SwiftShader — the rescaled engine helps MORE on real GPUs, as predicted).

## GPU acceleration (M6) — WebGL2 shaders  [BUILT + VALIDATED ON SWIFTSHADER; BROKEN ON REAL GPU — see ⚠️ above]

The per-pixel rasterization is migrated to GLSL fragment shaders (WebGL2), now the
DEFAULT engine (toggle in the UI). The high-precision reference orbit is still
computed on the CPU (BigInt) — only the cheap per-pixel delta/escape loop moves to
the GPU, which is the whole point. The CPU worker pool remains the fallback and
the ground-truth oracle (used below 2^-112 and whenever GPU is off/unsupported).
NOTE (Spawn 8): "VALIDATED" above means validated on SwiftShader. On real NVIDIA the
deep df64/fe/rescaled engines are numerically wrong (df64 reassociation, see ⚠️ section).

RESOLVED (Spawn 7): the deep render USED to be a single GPU draw on the main thread.
At extreme depth + high maxIter (e.g. 2^218 → maxIter ~55k) that one draw ran long
enough to trip the GPU watchdog (TDR) on real hardware → context loss → CPU fallback
(minutes) → "can't zoom past 2^218". The escape pass is now STRIP-TILED across many
short draws with a yield between them (viewer._drawTiledEscape), so no single draw
exceeds the watchdog, the UI stays responsive, and the image reveals top-to-bottom.
See the "Strip-tiled deep render" section below. (Running the GPU in an OffscreenCanvas
worker is still a possible future refinement, but is no longer needed to avoid the TDR.)

Files: src/gpu/glsl.js (shaders), src/gpu/renderer.js (WebGL2 plumbing),
src/gpu/validate.js (GPU-vs-oracle comparison), test/gpu/harness.html (browser
harness), tools/validate-gpu.mjs (the canonical GPU regression — run it!).

### The four GPU engines and the dispatch (empirically chosen, see below)
- **naive f32**     : radius >= 2^-2  (0.25). Shallow/home, where the view shows
  large parts of the set and a single-reference perturbation is inappropriate.
  No reference needed → instant. Boundary pixels (24-bit coord) may flip; bulk is
  exact (meanΔsn < 2 even at the worst valley at 0.25).
- **perturb df64**  : 2^-2 .. 2^-112. The deep workhorse. Reference orbit in a
  CPU-computed RGBA32F texture (Zx.hi,Zx.lo,Zy.hi,Zy.lo); deltas in df64 too.
  Validated vs the CPU perturbation oracle at the seahorse VALLEY (worst case)
  across 2^-3..2^-110: mism < 1.2% of pixels, meanΔsn < 1 (see validate-gpu).
  df64 extends the mantissa to ~46 bits but NOT the float32 exponent, so dc/dz
  ~2^-270 would underflow (min normal 2^-126) — hence the 2^-112 floor.
- **perturb floatexp / RESCALED** : 2^-112 .. 2^-340. THE 2^270 GPU PATH.
  Same df64 (~46-bit) mantissa, but each per-pixel delta carries an int exponent so
  dc/dz far below 2^-126 don't underflow. The reference Z stays df64 (it is O(1)). dc
  origin/step are passed in as fe (mantissa + exponent) from the CPU. Two
  implementations occupy this band: `perturbFragFloatexp` (per-component exponent, the
  validated reference) and `perturbFragRescaled` (shared exponent, ~1.26× faster, NOW
  THE DEFAULT the viewer dispatches — see the Spawn-6 rescaled section below). Both
  validated headless vs the CPU oracle to the same thresholds — correct on varied
  chaotic escapes (2^-70/2^-90, exponent path exercised) AND on escaping patches at
  2^-130..2^-340 (below the float32 floor) at 0% mismatch.
- **CPU perturbation** (existing worker pool): radius < 2^-340 or GPU unsupported.
  Still the ground-truth oracle, validated to 2^-400.

Also kept (validated, available, not the default): naive df64 shader and
perturb **f32** shader.

### floatexp ("fe") GPU deep path — how it works and why it's correct
The plain-df64 perturb shader floors at ~2^-112 because float32 cannot represent
the per-pixel offset dc ~ 2^-270 (it underflows to 0 below 2^-126). The fe engine
fixes exactly this: a real value is stored as `m * 2^e` where m is a df64 (vec2
hi/lo, ~46-bit, normalized so |m.x| in [0.5,1)) and e is a plain int. The df64
*mantissa* keeps the validated 46-bit precision; the int *exponent* gives the full
double range. Only the small deltas (dc, dz) need fe — the reference Z is O(1) and
stays df64; the 2*Z*dz product promotes Z into the fe via `fe_mulds` (df64×fe).
- src/gpu/glsl.js FE_LIB: fe_norm/add/sub/mul/mulds/dbl/lt/tof. Built on the df64
  ds_* ops. NOTE: WebGL2 is GLSL ES **3.00** which has NO frexp/ldexp (those are
  3.10). Normalization (Spawn 5, was log2/exp2 + a correction step) now reads/writes
  the IEEE-754 exponent field directly: `fe_ilogb1(x)=((floatBitsToInt(x)&0x7fffffff)
  >>23)-126` is the frexp exponent (k with |x|*2^-k in [0.5,1)); `fe_pow2(k)=
  intBitsToFloat((k+127)<<23)` is an exact 2^k. This is EXACT (no ±1 log2 rounding →
  no correction step, and no vendor-approx "sparkle" risk on Adreno/Mali) and far
  cheaper — see the perf section below. Valid because our mantissas stay in
  [~2^-50, 2], so every exponent we touch is inside the normal range [-126,127];
  `fe_tof` guards e<-126 → 0 (underflow), since fe_pow2 only covers e>=-126.
  Also: GLSL ES forbids the `?:` ternary on structs — use if/return.
- The rebase test |z| < |dz| MUST be done in fe (both sides ~2^-540 underflow a
  float), hence fe_lt. The escape test |z|^2 > bailout uses fe_tof (mag2 is O(1) at
  escape, representable). dz^2 is never converted to float — only compared via fe.
- src/gpu/renderer.js feSplit(double)->{hi,lo,e}; renderPerturbFloatexp() passes
  uOx/uOy/uScale as (vec2 mantissa, int exponent) pairs. Reuses uploadReferenceDf64.
- Validation (tools/validate-gpu.mjs, "perturb floatexp" section): two angles —
  (a) the 2^-70/-90 overlap band gives REAL varied chaotic escapes that exercise
  the exponent path and match the oracle's bulk metrics like df64 (esc≈9000,
  mism 0.3–1.1%); (b) escaping EXTERIOR patches at 2^-130..2^-340 (below the float32
  floor) confirm no underflow (esc=10000, mism 0.000%). Varied-chaotic escapes
  BELOW the floor aren't directly tested (they'd need ~maxIter≈30k → too slow under
  SwiftShader) but the fe arithmetic is exponent-magnitude-agnostic, so (a)+(b)
  together cover it. PERF: fe is still heavier than df64 (~5× after Spawn 5's opts,
  was ~19×), but it now renders much faster — see the shader-perf section below. On
  a real GPU it parallelises across pixels and should beat the single-thread-ish CPU
  path. GPU failure → CPU.

### GPU shader performance optimization (Spawn 5) — measured on SwiftShader
The fe (floatexp) deep path was the bottleneck. `tools/bench-gpu.mjs` (new) times a
pure render — a draw + a 1-px readPixels to force ANGLE/SwiftShader to actually run
the fragment work (gl.finish alone is elided when nothing reads the framebuffer) —
and reports Mit-px/s (= width·height·maxIter / ms). Two BIT-IDENTICAL optimizations
(validate-gpu mismatch numbers unchanged to the digit, so these are pure speed):

1. **fe_norm/fe_add/fe_tof via IEEE-754 bit ops, not log2/exp2.** The hot loop runs
   ~20 fe ops/pixel-iteration; the old normalize spent 2 transcendentals per fe_norm
   and fe_add 3 more exp2 — ~60+ software-transcendental calls per pixel-iteration,
   the dominant cost on SwiftShader (a CPU rasterizer). fe_ilogb1/fe_pow2 (above) do
   the same job with a few int ops. **~1.85× on the fe path** (matched-load A/B).
2. **Carry Z[m] across iterations (both df64 + fe perturb loops).** Each iteration
   fetched the reference texture twice (Z[m] at the top, Z[m+1] for the z=Z+dz test);
   the second IS the next iteration's first, so carry it and fetch once per iteration
   (re-fetch Z[0] only on rebase). **~2.4× on the deep df64 path** (texture sampling
   is a big fraction of df64's otherwise-lean per-iter work on SwiftShader) and
   **~1.2×** more on fe.

Combined, matched-load A/B at the seahorse valley (the expensive chaotic-escape case):
| path        | before | after | total |
|-------------|--------|-------|-------|
| df64 2^-80  | ~109   | ~262  | ~2.4× |   (Mit-px/s; df64 only got opt #2)
| fe   2^-80  | ~10.9  | ~21.7 | ~2.0× |
| fe   2^-270 | ~10.9  | ~21.8 | ~2.0× |
Absolute Mit-px/s drift with machine load (the companion LLM shares this CPU), so
the bench prints df64 + fe together and the ratios above are within-run/matched-load.
HONEST: SwiftShader is a CPU software GL; even at ~2× a full-screen ss=2 extreme-fe
render is still many seconds there. The point is (a) a real ~2-2.4× win that helps
every depth, and (b) a real GPU — where each pixel is a parallel thread — flies. The
single biggest remaining win is the **rescaled-iteration** rewrite (below).

### RESCALED single-exponent iteration (Spawn 6) — DONE, validated, now the deep default
fe carries a SEPARATE exponent per delta component and renormalizes after EVERY op
(~14 fe ops/iter, each a normalize + struct/branch). The rescaled engine
(`perturbFragRescaled`, src/gpu/glsl.js) keeps dz=(Dx,Dy) as df64 mantissas under ONE
shared int exponent S (dz=(Dx,Dy)·2^S), so the update 2·Z·dz + dz² + dc runs in raw
df64 (like the df64 path) and renormalizes S ONCE/iter. **It is now the engine the
viewer uses for the deep `gpu-perturb-fe` band** (viewer._renderGpuPerturb); the old
`renderPerturbFloatexp` stays in the renderer as the reference/oracle.

How the update works (per iteration, dz=(Dx,Dy)·2^S, dc=(Cx,Cy)·2^Sc collapsed once):
- linear  L = 2·(Zx·Dx−Zy·Dy, Zx·Dy+Zy·Dx), exponent S (Z is df64, O(1))
- quad    (Dx²−Dy², 2·Dx·Dy), exponent 2S, DROPPED when >52 bits below the frame
          (matches what fe_add does internally — at deep zoom dz²~2^-540 is invisible)
- dc      (Cx,Cy)·2^Sc
align all three to frame W = max(eL, qe, Sc) with exact power-of-two scalings
(ds_scale2), sum in df64, renormalize S once.

THE CATCH (deferred by Spawn 5) was the exact rebase magnitude compare. SOLVED simply:
the escape/rebase test still runs in EXACT floatexp — convert (Dx,S),(Dy,S) back to fe
per component (fe_norm) and run the byte-identical fe escape/rebase code. So the Zhuoran
decision logic is unchanged; only the cheap bulk update is rescaled. On rebase, z (fe per
component) is re-collapsed to shared (Dx,Dy,S).

TWO BUGS found + fixed while validating (both are general traps for this representation):
1. **Z_0 = 0 (Mandelbrot) makes the linear term vanish after EVERY rebase** (m=0,
   Z[0]=0 → 2·Z·dz = 0), so dz' = dz² + dc with dz² DOMINANT. The frame W must include
   the dz² exponent qe=2S; otherwise a vanished linear (ilogb1(0)=−126) picks a bogus
   frame that mis-scales dz², and the orbit NEVER ESCAPES after a rebase (exterior
   patches read 100% interior; chaotic pixels that rebase fail). W=max(eL,qe,Sc) fixes it.
2. **Un-normalized linear inflates the frame.** |2·Z·D| can be ~6; using S (not the
   linear's true exponent eL=S+ilogb(linear mantissa)) as the frame costs the dc/dz²
   addends ~2-3 low bits vs fe → mism 4× worse at the viewer's deep maxIter. Fold the
   linear's exponent into W (eL); the scaling ds_scale2(lx, S−W) needs no extra normalize.

PERF (matched-load A/B vs fe, seahorse valley = worst-case chaotic, SwiftShader):
**~1.26× faster than fe**, stable across 2^-80/-150/-270. (The escape/rebase block is
still fe and dilutes the update win on this maximally-divergent case; smoother deep
regions + a real GPU should do better.) PRECISION: validate-gpu's rescaled section uses
the SAME thresholds as fe and PASSES identically (2^-90 rs 0.977% vs fe 1.074% — rescaled
is even a hair better); rescaled agrees with fe bit-for-bit up to ~15k iters and to bulk
metrics beyond. tools/probe-rescaled.mjs (rs-vs-oracle + rs-vs-fe) and tools/crosscheck-
skip.mjs (the skip below) gate it.

### Perturb fast-skip (Spawn 6) — bit-identical, in all three perturb shaders
When dz is far below the O(1) reference Z_m, the true value z=Z_m+dz can neither escape
(|z|≤|Z_m|+|dz| ≪ 256) nor rebase (|z|≥|Z_m|−|dz| > |dz|), and the glitch test is false
(mag2~|Z_m|²) — so the whole escape/rebase/glitch block is INERT and is skipped
(`uFastSkip`). PROVABLY bit-identical: |dz|<2^(sdz+1), |Z_m|≥2^(ezm−1); ezm≥sdz+4 ⇒
|Z_m|>2|dz| (no rebase); ezm≤6 ⇒ |z|<256 (no escape); m≠uRefLen keeps the forced
end-of-ref rebase; below the df64 floor Z_m reads 0 (ezm=−126) and the exact path
wouldn't rebase either, so the skip still matches. tools/crosscheck-skip.mjs renders the
same view with the skip on and off and asserts a 0-diff full-image match (df64+fe+rs,
2^-20..-340 incl. the chaotic valley AND the escaping exterior). HONEST: on the chaotic
seahorse bench it gives ~1.00× — SwiftShader (and real GPUs) run pixels in SIMD groups,
so a `continue` saves nothing if ANY lane in the group still needs the block, and the
chaotic valley keeps groups busy. It's free (not slower) and helps SMOOTH contiguous
deep regions + real hardware, where whole groups skip together. The headline deep win is
the rescaled UPDATE (above), which every pixel runs every iteration regardless of divergence.

### Strip-tiled deep render (Spawn 7) — the fix for "zoom past 2^218"
THE 2^218 BARRIER WAS NOT PRECISION. Measured (tools/probe-deep218.mjs): the rescaled
+ floatexp engines match the CPU 53-bit oracle to **0.000% mism** on a real deep
coordinate all the way to 2^-271 (chaotic high-maxIter escaping regions), and the
reference builds in ~450ms. The actual wall: a deep frame needs maxIter ~55k (autoMaxIter
= 400 + 250·octaves), and the escape pass was ONE GPU draw over the whole screen. On a
real GPU a single 10–40s draw trips the **watchdog / TDR** → the browser resets the GL
context → viewer._gpuFail falls back to the CPU pool (minutes at that depth) → it looks
like "you can't zoom past 2^218". (On SwiftShader the same single draw just times out
>120s — confirmed via tools/shoot-deep.mjs, which showed gpu-perturb-fe, glitches:0, but
never finishing.)

THE FIX (viewer._drawTiledEscape + renderer scissor support): split the escape pass into
horizontal STRIPS and draw them one at a time, yielding a frame (requestAnimationFrame)
between draws.
- renderer: every escape method now calls `_bindEscapeTarget(p)` which sets the viewport
  to the FULL FBO (so gl_FragCoord — and therefore each pixel's c — is unchanged) and,
  when `p.stripH` is set, enables a SCISSOR rect (0, stripY, W, stripH) that restricts
  WHICH rows get written. Same gl_FragCoord + scissor ⇒ the tiled result is BIT-IDENTICAL
  to one big draw (tools/crosscheck-tiled.mjs: 0-diff across naive/df64/fe/rescaled, all
  depths incl. 2^-218, strip heights 1-row…larger-than-frame). `clearSn()` clears the sn
  target to interior (sn=-1) first so not-yet-drawn rows read as background → clean
  top-to-bottom reveal. colorize() now `disable(SCISSOR_TEST)` (a strip pass may leave it on).
- viewer: `_drawTiledEscape(drawStrip, gen)` clears sn, then loops strips — each draws,
  `gl.flush()`es (its own GPU command, so the watchdog timer is per-strip), colorizes +
  blits (progressive), and awaits a rAF. It checks `gen !== this.gen` each iteration so a
  zoom/pan/palette change mid-render cancels cleanly (the e2e "zoom mid-render cancels"
  covers this). `_renderGpuNaive` + `_renderGpuPerturb` are now async and route through it.
- `_stripRows()` sizes a strip so its worst-case work (rows·W·maxIter pixel-iterations)
  stays under a ~watchdog budget (4e8 pixel-iters/strip), aligned to the supersample
  factor, ≥ ss, ≤ frame height. Shallow/cheap views collapse to a single full-frame strip
  (no overhead). At 2^218 (W~840, maxIter~55k) that's ~10-row strips, ~150 strips; the rAF
  overhead (~16ms each) is a few % of the real per-strip compute on a real GPU.
HONEST: tiling does NOT make the total work smaller — a full 2^218 frame on a real GPU is
still ~tens of seconds (and is unrenderable on SwiftShader, a CPU rasterizer, regardless).
What it buys: no watchdog reset (the hard barrier), a responsive UI, a progressive reveal,
and free cancellation. The next *speed* levers (untouched, precision-safe-ish): auto-drop
supersampling as depth grows (ss² multiplies the heavy fe cost), and a cheaper-common-case
escape/rebase block (AGENDA NEXT). Driver fragment-loop caps (some mobile GPUs cap shader
loop iterations) are a separate possible failure mode that tiling does NOT address — if a
real device still mis-renders deep, suspect that and tile the ITERATIONS too (multi-pass).

### Display pipeline — point filtering + supersampling (this spawn)
Two separate scaling stages, filtered oppositely on purpose:
- **Supersample (compute res → display res): smoothing ON.** The fractal is computed
  at `ss×` the display backing (default 2×) and box-averaged down. This is the AA /
  "ultra" smoothness. Average the FINAL COLORS of the ss×ss subsamples, NOT the
  smooth-count sn (sn is cyclic through the palette — averaging it bleeds hues).
  - GPU: the color shader (COLOR_FRAG, uSS) loops the ss×ss block and averages
    colors; the sn FBO is ss× the canvas. renderer _ensureFbo (compute res) is now
    decoupled from the canvas (display res, sized in colorize()).
  - CPU: workers render at compute res into an offscreen compute canvas; present()
    downscale-blits it to the display canvas (smoothing on = the box filter),
    rAF-coalesced. ss==1 keeps the old direct-to-display path (no extra blit).
  - Caps: effective ss bounded by MAX_COMPUTE_DIM (8192) and MAX_COMPUTE_PIXELS
    (12e6, ≈ a 192MB float sn texture) so mobile GPUs don't OOM; bands are aligned
    to ss so each maps to whole display rows.
- **Display → screen (CSS upscale, and the zoom-gesture preview): point filter
  (nearest), no smoothing.** `#view { image-rendering: pixelated }` and
  `_applyPreview` uses `imageSmoothingEnabled=false`, so the image stays CRISP when
  the browser scales backing→screen and when a gesture scales the last frame.
  (Danielle: "point filter not bilinear, more crisp especially when zooming.")
  ss + URL hash (`ss=`) + a Supersampling select in the panel; debug shows `_effSS`.

### KEY PRECISION FINDINGS (hard-won — measured headless via SwiftShader)
1. **df64 (double-single, two float32) is correct and ~46-bit.** It matches CPU
   double exactly in well-conditioned regions. df64 extends the *mantissa* but
   NOT the float32 *exponent* (still ~2^-126 floor) → df64 reaches ~2^-112 zoom,
   not deeper. (To go past 2^-112 on GPU you need per-pixel floatexp; future.)
2. **f32 perturbation breaks at high maxIter, even deep.** It is exact only while
   maxIter stays under a depth-dependent threshold, then jumps to 10–30% boundary
   error (meanΔsn 6–23). Cause: the f32 reference Z_m + f32 deltas carry ~2^-24
   absolute error in the reconstruction z = Z_m + dz; once dz grows toward O(1)
   near escape, that error amplifies on chaotic high-count pixels. The viewer's
   autoMaxIter (~250/octave) is well into the breakdown, so **f32 perturbation is
   NOT safe as the default** — hence df64.
3. **df64 perturbation fixes it**: same cases drop from 10–30% to 0–1.2% mism,
   meanΔsn < 1 (a ~20–30× improvement). The residual <1.2% is the genuine
   46-bit(df64) vs 53-bit(double) gap on measure-zero chaotic boundary pixels —
   the SAME effect NOTES already documents for naive-vs-perturbation. The BigInt
   arbiter (tools/arbiter-gpu.mjs) confirms these mismatches are precision, not
   bugs: GPU-unique-wrong pixels are always high-count sensitive ones where CPU
   double ALSO differs from BigInt.
4. **Validate on BULK metrics, not max.** Two finite-precision methods always
   disagree on a few chaotic pixels. Gate on (fraction of pixels differing) +
   (mean Δsn over escaped pixels), never on max Δsn. This mirrors the existing
   "validate vs BigInt, not naive" wisdom.

### Coordinate mapping (single source of truth, mirrored in JS for validation)
Shader: c = uOrigin + gl_FragCoord.xy * uScale, with gl_FragCoord = texel + 0.5.
readPixels row 0 = GL bottom. validate.js recomputes the exact c per texel so the
oracle evaluates the identical point — orientation/flip never affects the check.
df64 uniforms are passed as (hi,lo) via df64Split(double) = [fround(v), fround(v-hi)].

### Smooth-count + coloring parity
Shaders compute sn bit-identically to naive.js/perturb.js. The color pass samples
a 1024×1 RGBA8 LUT baked on the CPU from palette.colorFor — so GPU and CPU coloring
match to LUT resolution. sn<0 = interior (same sentinel as CPU).

### Running the GPU browser (NixOS) — WebGL2 works headless
SwiftShader (ANGLE/Vulkan) gives WebGL2 + EXT_color_buffer_float (RGBA32F render
targets) + 8192 max texture (a 2M-iter reference fits in 2048×N). highp float = 23
mantissa bits (real float32). Same chromium 148 + --headless=new + --no-sandbox
+ --enable-unsafe-swiftshader as the e2e setup. tools/probe-webgl.mjs verifies it.

## Performance / scaling reality (single worker today)
~300M iteration-steps/sec single thread. A full-screen deep view (e.g. 2^100 at
~60k iters over ~500k px) is ~tens of seconds single-threaded. Progressive passes
make it usable (coarse image fast), but the NEXT big win is multi-worker tiling
(fan tiles across cores; share the one reference orbit via SharedArrayBuffer —
COOP/COEP already enabled). Then GPU for shallow/medium. Deep zoom correctness is
done and validated; this is purely about speed.
