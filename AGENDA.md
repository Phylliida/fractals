# AGENDA — Mandelbrot Deep-Zoom Viewer (perturbation theory)

Goal: mobile-first Mandelbrot viewer reaching zoom ~2^400, JS+HTML+CSS, GPU where
it helps, extensive browser automation + integration tests, validated against
ground truth, with accurate glitch detection.

Status legend: [ ] todo · [~] in progress · [x] done & verified · [!] blocked

## M0 — Scaffold & test harness  ✅
- [x] package.json, ES-module layout, static dev server (tools/serve.mjs)
- [x] Playwright wired to a working chromium (see NOTES: NixOS browser saga)
- [x] e2e tests load the page and assert the canvas renders (18 tests, 2 projects)

## M1 — Ground-truth naive renderer (double precision)  ✅
- [x] naive.js: escape-time Mandelbrot in plain doubles (THE reference oracle)
- [x] canvas viewer with view state (center, radius, maxIter) — viewer.js
- [x] mobile touch: pinch-zoom + drag-pan + double-tap; wheel fallback
- [x] palette/coloring (smooth iteration count) — palette.js, 4 palettes
- [x] unit tests: known points (cardioid, period bulbs, escape counts)

## M2 — High-precision arithmetic
- [x] bignum.js: fixed-point BigInt real + complex (mul/cmp/toDouble/decimal IO)
- [x] unit tests vs known values, decimal round-trip, huge-prec no-overflow

## M3 — Reference orbit
- [x] reference.js: high-precision orbit Z_n at view center -> Float64 arrays
- [x] escape / maxIter handling; escapeBigInt exact single-point oracle
- [x] validate: reference orbit == naive double orbit (early iters) [test D]

## M4 — CPU perturbation engine (THE correctness core)  ✅ VALIDATED
- [x] perturb.js: delta iteration dz' = 2*Z*dz + dz^2 + dc (double precision)
- [x] Zhuoran rebasing for glitch-free single-reference rendering
- [x] Pauldelbrot glitch diagnostic exposed (rendering relies on rebasing)
- [x] render.js: reference auto-selection (relocate to deepest pixel)
- [x] VALIDATE vs BigInt-exact oracle: +/-1 at 2^45, 2^120, **2^400** [B,C,C2]
      KEY FINDING: validate vs BigInt, not naive. naive=perturb only use doubles;
      both noisy on ill-conditioned shallow boundary pixels. Dispatch naive
      (shallow) / perturb (deep) by radius. See NOTES.

## M5 — Workers + progressive deep zoom  ✅
- [x] worker.js: POOL of N module workers (navigator.hardwareConcurrency, cap 12).
      worker[0] computes the reference once + a coarse pass; row-bands are then
      fanned round-robin across the pool. ~8x faster deep render (15.7s -> 2.0s
      on the full-screen deep e2e).
- [x] progressive: instant coarse pass (step 8) then parallel full-res bands
- [x] cancellation on view change (terminate pool + generation guard)
- [x] deep-zoom: 2^41, 2^60 render glitch-free in-browser; 2^100/2^400 in Node
- [x] iteration auto-scaling with depth (autoMaxIter in render.js)

## M6 — GPU acceleration (WebGL2)  ⚠️ BUILT + VALIDATED-ON-SWIFTSHADER; BROKEN ON REAL GPU
## (Spawn 8: real-GPU testing works now and revealed the deep df64 engines are wrong on
##  real NVIDIA — df64 reassociation. Partial fix shipped; see NEXT #0 + NOTES "⚠️".)
- [x] naive GPU shader (shallow zoom, float32) + a df64 variant (medium)
- [x] perturbation shader: **df64** reference + df64 deltas + Zhuoran rebasing.
      (f32 perturb shader also built/validated but NOT default — see finding 2.)
- [x] validate GPU output vs CPU naive/perturbation oracle headless (SwiftShader)
      across 2^0..2^-110; tolerance on chaotic boundary pixels (bulk metrics).
      tools/validate-gpu.mjs (canonical), tools/arbiter-gpu.mjs (BigInt arbiter).
- [x] auto-pick GPU/CPU by depth: naive-f32 (r>=2^-2) / perturb-df64 (2^-2..2^-112)
      / **perturb-floatexp (2^-112..2^-340, the 2^270 GPU path)** / CPU perturb below
      + on any GPU failure. gpuEngineForRadius() in render.js.
- [x] **floatexp GPU deltas (df64 mantissa + int exponent)** push GPU perturb past
      the df64 float32-exponent floor (2^-112) to 2^-340: dc/dz ~2^-270 no longer
      underflow. VALIDATED headless vs the CPU oracle (varied chaotic escapes in the
      2^-70/-90 overlap band + escaping patches 2^-130..2^-340 below the float32
      floor, 0% mism). src/gpu/glsl.js FE_LIB + perturbFragFloatexp. (Spawn 4)
- [x] in-shader coloring via a CPU-baked palette LUT (no readback for display)
- [x] **SHADER PERF (Spawn 5)**: two bit-identical speedups, measured on SwiftShader
      via the new tools/bench-gpu.mjs. (1) fe normalize via IEEE-754 bit ops
      (fe_ilogb1/fe_pow2) instead of log2/exp2 — removes ~60 software transcendentals
      per pixel-iteration (~1.85× on fe). (2) carry the reference Z[m] across loop
      iterations (one texture fetch/iter, not two) in the df64 + fe + f32 perturb
      loops (~2.4× on deep df64, ~1.2× more on fe). Net ~2.0× fe, ~2.4× df64;
      validate-gpu mismatch numbers unchanged to the digit.
- [x] **RESCALED DEEP ENGINE (Spawn 6)**: the deferred rescaled single-exponent
      iteration, built + hard-validated + shipped as the deep default. dz=(Dx,Dy)·2^S
      shares ONE exponent; the 2·Z·dz+dz²+dc update runs in raw df64, renormalized
      once/iter; escape/rebase stays EXACT floatexp (so the Zhuoran decision is
      unchanged). ~1.26× faster than fe (matched-load, worst-case chaotic valley);
      validate-gpu's rescaled section passes the SAME thresholds as fe. Two bugs found
      + fixed (general traps): the dz² exponent must be in the combine frame (else the
      Z_0=0-after-rebase linear-vanish never escapes), and the linear's true exponent
      must set the frame (else ~2-3 lost low bits). src/gpu/glsl.js perturbFragRescaled.
- [x] **PERTURB FAST-SKIP (Spawn 6)**: skip the escape/rebase/glitch block when dz is
      provably too small to escape or rebase. Bit-identical (crosscheck-skip renders
      skip on/off → 0 diff across df64+fe+rs, 2^-20..-340). Free on the chaotic bench
      (SIMD divergence), helps smooth deep regions + real GPUs (whole groups skip).
- [x] viewer integration: GPU is the DEFAULT; CPU worker pool is fallback+oracle;
      UI toggle "GPU acceleration"; debug shows the active renderer.
- [x] e2e: WebGL2 present, GPU-vs-oracle match, app dispatches gpu-*, CPU fallback
- [x] **STRIP-TILED DEEP RENDER (Spawn 7)**: the deep escape pass is split into short
      horizontal strips (scissor) drawn one at a time with a rAF yield between them, so a
      deep frame (maxIter ~55k at 2^218) never trips the GPU watchdog (TDR) — THE actual
      barrier to "zooming past 2^218" (measured: the engine is numerically perfect to
      2^-271; the wall was one long draw, not precision). Progressive top-to-bottom reveal,
      cancellable mid-render. BIT-IDENTICAL to a single draw (tools/crosscheck-tiled.mjs).
- [ ] FUTURE: OffscreenCanvas worker for the GPU (offload the deep draw off the main
      thread entirely); auto-drop supersampling as depth grows (ss² multiplies the heavy
      fe cost) for snappier deep frames; multi-pass over ITERATIONS if a real device caps
      fragment-shader loop length. Deepest zooms (< 2^-340) still fall back to CPU.

## M7 — Mobile UX polish
- [~] responsive canvas/DPR (done, capped backing); tiled render + low-power TODO
- [x] **point filtering** (image-rendering: pixelated + preview imageSmoothingEnabled
      =false) → crisp, not bilinear-blurry, especially mid-zoom. (Spawn 4)
- [x] **supersampling** (1×/2×/3×/4×, default 2×): compute at ss× display res, box-
      average colors down (GPU color-shader / CPU compute-canvas downscale). Anti-
      aliases the boundary filaments — the "ultra" smooth look. UI select + URL hash.
      (Spawn 4)
- [x] palette options (4), iteration slider + **number input field** + auto toggle, coords
- [x] bookmarks / shareable deep-zoom coordinates (URL hash) + "Go" + presets
- [x] loading/progress UI (status line + reference-orbit progress)
- [x] zoom UX: any zoom (wheel/buttons/click/pinch) instantly cancels the
      in-flight render and shows the *current image scaled* as a preview; the
      sharp re-render is deferred until the zoom motion settles. A pointer tap with
      no movement no longer cancels a running render. (viewer.js zoomBy/_beginPreview)
- [x] **click-to-zoom (Spawn 5)**: a single click/tap recenters the view on the
      clicked point AND zooms in (radius×0.5); shift/ctrl/right-click zoom out
      (radius×2). Uses the same preview-transform + settle machinery (instant scaled
      preview, deferred sharp render). Replaced the old double-tap handler.
      (viewer.js clickZoom; e2e: click recenters+zooms, real-mouse-click wiring)
- [ ] glitch overlay debug toggle (glitch count shown; visual overlay TODO)

## M8 — Extensive integration tests  ✅ (perf budgets TODO)
- [x] e2e: load, render, pan, zoom, deep-zoom-by-coordinate, palette (18 tests)
- [x] golden fingerprint determinism test (reproducible render hash)
- [x] perturbation-vs-BigInt equivalence (Node, to 2^400) + full-pipeline deep
- [ ] performance budget assertions (time-to-first-pixel, frame budget)

See NOTES.md for architecture, math, and decisions.

---
## NEXT (priority order for the next spawn)
0. **⚠️ FIX THE DEEP GPU CORRECTNESS BUG ON REAL HARDWARE (Spawn 8 found it).** Real-GPU
   testing now works (`GPU=1`/`GPU=gl`, see NOTES "⚠️ REAL-GPU TESTING"). It immediately
   exposed that the deep df64/floatexp/rescaled engines are NUMERICALLY WRONG on real NVIDIA
   (20–99% wrong pixels ≥ ~2^-12) — every prior spawn validated only on SwiftShader, which
   hid it. Cause: the NVIDIA shader compiler reassociates the Veltkamp split (`ca-(ca-x)→x`),
   collapsing df64→float32. A per-op XOR-uniform barrier (shipped in DF64_LIB) fixes the
   ISOLATED ops but the driver still defeats it in the large inlined perturbation shader
   (validate:gpu:real still 12 FAIL). TWO tracks:
   (a) **SHIP NOW, independent of the shader: a GPU deep-precision self-test + CPU fallback.**
       First deep render → render a small known tile on GPU, compare escape counts to the CPU
       oracle (escapePerturb, already in-browser); if mism > tol, mark GPU-deep untrusted and
       route deep renders to the CPU pool. Makes the viewer CORRECT on ALL hardware today.
       THE highest-value action — real users currently get wrong deep fractals on real GPUs.
   (b) Crack the shader: stronger/un-CSE-able barrier, or split the shader so the driver has
       less to reassociate. Inner-loop signal: probe-xbackend (GPU-df64 vs SwiftShader-df64,
       should → ~0%); gate: validate:gpu:real. Needs NVIDIA ISA introspection ideally.
   NOTE: strip-tiling (Spawn 7) AND fast-skip (Spawn 6) ARE bit-identical on the real GPU
   (crosscheck-tiled/skip with GPU=1 → 0-diff) — those mechanisms are sound; only the df64
   precision is broken. The 2^218 watchdog win still can't be directly measured (the tiny
   bench/crosscheck sizes finish instantly; need a full-screen deep frame timing on real HW).
1. **Real-GPU validation of the rescaled engine + the fast-skip** (Spawn 6 built both,
   validated on SwiftShader). On a real GPU: (a) confirm the rescaled deep band is
   visibly faster than fe and free of boundary sparkle (validate-gpu has ~1% headroom;
   the rescaled section passes it, but a real GPU + a wider sweep is the final check);
   (b) the fast-skip is ~1.00× on the chaotic SwiftShader bench (SIMD divergence) but
   should help SMOOTH deep regions where whole pixel-groups skip — measure that win on
   real hardware. If the rescaled engine ever misbehaves, viewer._renderGpuPerturb can
   fall back to renderPerturbFloatexp (still in the renderer, still validated) in one line.
2. FURTHER deep speed: the rescaled UPDATE is now ~df64-cheap, so the escape/rebase
   block (still exact floatexp, ~half the per-iter cost on the chaotic case) is the new
   bottleneck. The escape test only fires when |dz| is large (S high) and rebases are
   CORRELATED across pixels (driven by the shared reference's near-0 passages, same m),
   so a cheaper-common-case escape/rebase (df64 when z is O(1), fe only near a reference
   minimum) could win more — but it's precision-critical; validate hard.
3. PERF + PRECISION on a real GPU/device (the floatexp path is correct but HEAVY;
   Spawn 5 made it ~2× faster on SwiftShader but it's still a CPU SW rasterizer):
   - verify 2^270 renders fast; if a single fe draw is too long, strip-tile it
     across draw calls (scissor + yield) and/or move the GPU renderer into a Worker
     via OffscreenCanvas (also fixes the mobile-watchdog/TDR risk for the df64 path).
   - REGISTER PRESSURE: fe (df64 mantissa + int exp + perturb state) uses many
     registers; if it spills, occupancy and speed tank non-linearly. A "High
     precision (deep)" vs "Fast" UI toggle could be a safety valve.
   - supersampling multiplies the heavy fe cost by ss² — measure before defaulting
     2× at extreme depth (maybe auto-drop ss as depth grows / on battery). This is a
     cheap practical "snappier deep zoom" win even before the rescaled rewrite.
   (Reference Z is NOT a drift risk: render() recomputes the reference fresh at the
   current center + relocates to the deepest pixel every view change — no staleness.)
3. Push the floatexp floor below 2^-340 toward the 2^-400 CPU range (the fe math
   already handles it; just extend + validate the band). Reference is df64 (46-bit)
   — if chaotic-pixel noise grows too far deep, store the reference as fe too.
4. Glitch overlay: the GPU shaders already emit a Pauldelbrot glitch flag in the
   sn texture's .b channel — surface it as a debug overlay (and read it back to
   report a real glitch count for GPU renders, currently reported as 0).
5. Perf-budget e2e assertions (time-to-first-pixel, full-render budget); low-power
   mode (cap resolution / maxIter / supersampling on battery).
6. Optional: series approximation to skip initial iterations (diminishing returns
   given rebasing already works).

## Progress log (newest first)
- Spawn 8 (why GPU not used for tests → profile the shaders — user request): GPU now WORKS
  for the tests, and using it immediately exposed a serious hidden bug.
  - WHY NO GPU: headless Chromium defaults to the SwiftShader CPU rasterizer for WebGL, and
    our flags `--disable-gpu --enable-unsafe-swiftshader` forced it. FIX: select an ANGLE GPU
    backend. New shared tools/chromium-launch.mjs picks SwiftShader (default) / Vulkan (GPU=1)
    / native GLES (GPU=gl); all 13 tools + playwright.config now use it. Verified on RTX 3090
    headless: `ANGLE (NVIDIA, Vulkan 1.4.312 … RTX 3090)`, EXT_color_buffer_float, maxTex 32768.
    ~600× faster than SwiftShader. tools/probe-gpu-real.mjs is the flag-combo sweep.
  - THE BUG (found by running validate on the real GPU): the deep df64/floatexp/rescaled
    engines are NUMERICALLY WRONG on real NVIDIA — 12 FAIL on validate:gpu:real (20–99% wrong
    pixels ≥ ~2^-12), all PASS on SwiftShader. Root cause PROVEN (tools/probe-df64.mjs): the
    NVIDIA compiler reassociates the Veltkamp split `ca-(ca-x)→x`, zeroing it → df64 silently
    collapses to float32. SwiftShader doesn't reassociate, so it hid the bug for 6 spawns.
  - PARTIAL FIX (shipped): an optimization barrier ob(x)=intBitsToFloat(floatBitsToInt(x)^
    uOptBarrier), uOptBarrier a uniform==0 the compiler can't fold (a plain bitcast round-trip
    IS folded away — proven). Wrapped every rounded result in DF64_LIB ds_add/ds_mul; renderer
    sets uOptBarrier=0 per program. Makes the ISOLATED ops intact on GPU (relerr ~1e-14 ==
    SwiftShader; probe-df64-real.mjs) and NO SwiftShader regression (29 PASS / 0 FAIL, 31 unit).
    BUT the full perturbFragDf64 still diverges (probe-xbackend: GPU-df64 vs SwiftShader-df64
    21%@2^-22 … 90%@2^-50): the driver re-optimizes the large inlined shader past the per-op
    barrier. Ruled out: fast-skip (identical), FTZ/subnormals (both backends flush — probe-ftz),
    reference texture, loop cap. Native GLES fails identically to Vulkan ⇒ NVIDIA driver backend.
  - VALIDATED SOUND ON REAL GPU (GPU-vs-GPU, so precision-independent): strip-tiling
    (crosscheck-tiled, 0-diff) and fast-skip (crosscheck-skip, 0-diff). Those mechanisms work.
  - PROFILING (bench:gpu:real): rescaled is ~2.1× faster than fe on the real GPU (vs 1.26× on
    SwiftShader) — the rescaled engine helps MORE on real hardware, as Spawn 6 predicted. (Full
    profiling deferred until the deep path is CORRECT — no point timing wrong output.)
  - NEW TOOLS: chromium-launch.mjs, probe-gpu-real, probe-df64, probe-df64-real, probe-xbackend,
    probe-ftz, probe-collapse; harness compareDf64VsF32/renderIter; npm GPU scripts. NEXT #0 has
    the recommended fix (GPU self-test + CPU fallback — makes the viewer correct on ALL HW now).
- Spawn 7 (zoom past 2^218 — user request): DIAGNOSED then FIXED. The barrier was NOT
  precision. Measured (tools/probe-deep218.mjs) the rescaled + floatexp engines vs the CPU
  53-bit oracle on a real deep coordinate at 2^-90…2^-271 (chaotic, high maxIter): **0.000%
  mismatch** throughout, reference builds ~450ms. The actual wall: a deep frame needs maxIter
  ~55k, and the escape pass was ONE GPU draw over the whole screen → a 10–40s single draw
  trips the GPU watchdog (TDR) on real hardware → context loss → CPU fallback (minutes) →
  "can't zoom past 2^218". (On SwiftShader the same draw just times out >120s, confirmed via
  tools/shoot-deep.mjs: gpu-perturb-fe, glitches:0, never finishing.)
  - FIX: STRIP-TILE the escape pass. renderer `_bindEscapeTarget` keeps the viewport on the
    FULL FBO (gl_FragCoord unchanged) and uses a SCISSOR rect (0,stripY,W,stripH) to restrict
    which rows are written; `clearSn()` pre-clears to interior. viewer `_drawTiledEscape`
    loops strips — draw, flush (own GPU command → per-strip watchdog), colorize+blit
    (progressive top-to-bottom reveal), await rAF (responsive + lets the GPU drain), with a
    `gen` guard each iteration for clean mid-render cancellation. `_renderGpuNaive` +
    `_renderGpuPerturb` are now async through it; `_stripRows()` sizes strips to a ~4e8
    pixel-iter watchdog budget (shallow views = one strip). Applies to naive/df64/fe/rescaled.
  - BIT-IDENTICAL to a single draw — tools/crosscheck-tiled.mjs: 0-diff (iter/sn/glitch)
    across all engines, depths incl. 2^-218, strip heights 1-row…larger-than-frame.
  - VALIDATION (all green): 31 unit; validate-gpu ALL PASS with IDENTICAL baseline mismatch
    numbers (renderer single-draw path unchanged); crosscheck-tiled 0-diff; crosscheck-skip
    still 0-diff (after the _bindEscapeTarget refactor); 42 e2e (incl. deep dispatch + zoom-
    mid-render-cancel); smoke gpu OK (gpu-perturb-fe @2^-150). Screenshot: a structured
    seahorse renders through the tiled path (screenshots/tiled_seahorse_2e50.png, glitches:0).
  - HONEST: tiling removes the watchdog barrier + adds responsiveness/progressive/cancel; it
    does NOT reduce total work, so a deep frame is still ~tens of seconds on a real GPU (and
    unrenderable on SwiftShader). Next speed levers in NEXT #0/#2. New: tools/{crosscheck-
    tiled,probe-deep218,shoot-deep}.mjs + npm scripts. NOTES/AGENDA/README updated.
- Spawn 6 (optimize GPU deep zoom further — user request): the deferred rescaled
  single-exponent engine, BUILT + HARD-VALIDATED + shipped as the deep default, plus a
  bit-identical fast-skip. Net deep speedup ~1.26× over fe (matched-load, worst-case
  chaotic valley) with NO precision regression.
  - RESCALED ENGINE (perturbFragRescaled): dz=(Dx,Dy)·2^S shares ONE int exponent; the
    2·Z·dz+dz²+dc update runs in raw df64 (align linear/dz²/dc to frame W=max(eL,qe,Sc)
    by exact power-of-two scalings, renormalize S once) instead of fe's ~14 per-op
    normalizes. The Zhuoran rebase CATCH (the reason Spawn 5 deferred this) is sidestepped:
    escape/rebase still runs in EXACT floatexp (convert dz→fe per component), so the
    decision logic is byte-identical to the fe engine; only the cheap bulk update is
    rescaled. Wired as the engine the viewer's gpu-perturb-fe band dispatches;
    renderPerturbFloatexp kept as the reference/oracle + one-line fallback.
  - TWO BUGS found + fixed (general traps for this representation, documented in NOTES):
    (1) Z_0=0 (Mandelbrot) makes the linear term vanish after EVERY rebase, leaving dz²
    dominant — the combine frame must include the dz² exponent (qe=2S) or the orbit never
    escapes post-rebase (exterior patches read 100% interior). (2) the linear's TRUE
    exponent (not S) must set the frame, else the un-normalized |2·Z·D|~6 costs the dc/dz²
    addends ~2-3 low bits → 4× worse mism at the viewer's deep maxIter.
  - FAST-SKIP (all three perturb shaders): skip the escape/rebase/glitch block when dz is
    provably too small to escape or rebase (|Z_m|>2|dz| and |Z_m|<64). PROVEN bit-identical
    (crosscheck-skip: skip on vs off → 0-diff full image, df64+fe+rs, 2^-20..-340 incl. the
    chaotic valley + escaping exterior). ~1.00× on the chaotic bench (SIMD divergence runs
    the block for the whole group if any lane needs it); free + helps smooth regions + real GPUs.
  - VALIDATION: 31 unit + 42 e2e (mobile+desktop, viewer+gpu) + smoke all green; validate-gpu
    ALL PASS incl. a new rescaled section at the SAME thresholds as fe (2^-90: rs 0.977% vs
    fe 1.074% — rescaled a hair better). New tools: crosscheck-skip.mjs, probe-rescaled.mjs;
    bench-gpu now A/Bs fe-vs-rescaled. NOTES/AGENDA/README updated.
- Spawn 5 (click-to-zoom + deep-zoom shader perf — user request): both done + validated.
  - CLICK-TO-ZOOM: viewer.js `clickZoom(px,py,factor)` recenters the clicked complex
    point to screen-center AND zooms (radius×factor), reusing the preview-transform +
    settle path (instant scaled preview, deferred sharp render). A no-drag tap/click
    → zoom in (0.5); shift/ctrl/right-click → zoom out (2); context menu suppressed.
    Removed the old double-tap handler (a single tap now zooms). +2 e2e (×2 projects)
    = 42 viewer e2e green: clickZoom math (recenter+zoom+deferred) + real-mouse wiring.
  - SHADER PERF (the headline): first ever TIMED on this host via new tools/bench-gpu
    .mjs (draw + 1-px readPixels forces SwiftShader to actually run the work — gl
    .finish is elided when the FBO is unread). Found fe was ~19× slower than df64.
    Two BIT-IDENTICAL opts (validate-gpu mismatch numbers unchanged to the digit):
    (1) fe normalize via IEEE-754 bit ops (fe_ilogb1=read exponent field, fe_pow2=
    write it) instead of log2/exp2 — kills ~60 software transcendentals per pixel-
    iteration (~1.85× on fe, AND removes the Adreno/Mali sparkle risk since it's now
    exact). (2) carry the reference Z[m] across loop iterations → one texture fetch/
    iter not two, in the df64+fe+f32 perturb loops (~2.4× on deep df64, ~1.2× on fe).
    Net matched-load A/B at the seahorse valley: df64 2^-80 ~109→~262 Mit-px/s (~2.4×),
    fe 2^-80 ~10.9→~21.7 (~2.0×). Honest: SwiftShader is CPU SW GL so extreme fe is
    still many seconds; the win helps every depth and a real GPU flies. Biggest
    remaining win (rescaled single-exponent iteration, ~1.5× more) documented in NOTES
    + NEXT #1 with its rebase-test catch — deferred for a real-GPU spawn, not risked.
  - Validation: 31 unit + 52 e2e (42 viewer + 10 gpu, ×2 projects) green; validate-gpu
    ALL PASS bit-identical (df64 2^-3..-110, fe overlap 2^-70..-110, fe exterior
    2^-130..-340). bench-gpu added. No correctness regression.
- Spawn 4 (point filter + supersampling + GPU 2^270 — user request): all three done.
  - NB: the reference URL Danielle gave for "ultra" 2^270 serves OUR EXACT code
    (byte-identical main.js/viewer.js/glsl.js) — it's this project on another host, so
    it ALSO falls back to CPU at 2^270; it just shows the target image quality.
  - POINT FILTERING: `#view { image-rendering: pixelated }` + `_applyPreview`
    imageSmoothingEnabled=false → crisp display + crisp zoom-gesture scaling (was
    bilinear-blurry). The supersample DOWNSCALE keeps smoothing on (that's the AA).
  - SUPERSAMPLING: render at ss× display res, box-average COLORS down (not sn —
    sn is cyclic). GPU: COLOR_FRAG averages the ss×ss block, FBO decoupled from the
    display canvas. CPU: offscreen compute canvas + rAF-coalesced downscale present.
    UI select (Off/2×/3×/4×, default 2×) + URL hash `ss=`; effSS capped for memory.
  - GPU 2^270 = FLOATEXP engine: extended df64 to `m*2^e` (df64 mantissa + int
    exponent) so dc/dz ~2^-270 stop underflowing float32's 2^-126 floor. New GLSL
    FE_LIB + perturbFragFloatexp; gpuEngineForRadius now naive / perturb-df64 /
    perturb-fe (2^-112..2^-340) / CPU. Gotchas: WebGL2=GLSL ES 3.00 has NO
    frexp/ldexp (3.10) → log2/exp2 normalize; no `?:` on structs. VALIDATED headless
    vs CPU oracle: varied chaotic escapes match df64 (2^-70/-90) AND escaping patches
    2^-130..2^-340 below the float32 floor at 0% mism. Wired as the GPU default for
    that band (CPU fallback on failure). Perf on real GPU still to be measured.
  - Tests: +6 unit (feSplit round-trip across 2^-340, dispatch bands) = 31 unit;
    +2 e2e (point-filter CSS, supersampling res+image-change); validate-gpu extended
    with the floatexp section (all PASS); smoke asserts gpu-perturb-fe at 2^-150.
    Fixed 2 deep e2e timeouts (ss=2 made SwiftShader 4× slower) by ss=1 in those.
- Spawn 3 (UX refinements — user request): iteration input field + zoom responsiveness.
  - Added a number input (`#iterNum`) beside the iterations slider so users can type
    an exact/large iteration count (1..2,000,000). Slider scrubs (100-step); the
    number field is precise. Both commit on `change` (release/Enter/blur), stay in
    sync, and uncheck "Auto iterations". index.html/styles.css/main.js.
  - Zoom now defers rendering: introduced `Viewer.zoomBy(factor,px,py)` →
    `_beginPreview()` (snapshot current frame, cancel in-flight render: gen++ +
    terminate pool) + `_scheduleSettle()` (debounced real render ~220ms after motion
    stops). Wheel, zoom +/- buttons, and double-tap all route through it and show the
    *scaled current image* during the gesture instead of re-rendering live.
  - Fixed a latent bug: a tap (pointerdown→up, no move) used to terminate the worker
    pool of an in-flight render. Preview now begins lazily on the first real move, so
    taps leave a running render alone. Also fixed deep double-tap killing its own
    render (it now previews+settles instead of render-then-terminate).
  - Tests: +3 e2e (iteration field commit/sync, zoom preview+deferred render, zoom
    mid-render cancellation). Full suite green: 26 unit + 34 e2e (17×2 projects).
- Spawn 2 (GPU / GLSL migration — user request): migrated the per-pixel raster to
  WebGL2 fragment shaders, GPU now the default engine, CPU pool the fallback+oracle.
  - Read mandelbrot-deep-zoom.md; took its perturbation/floatexp framing into the
    shader design (df64 reference + glitch criterion + smooth coloring parity).
  - Engines: naive-f32 (r>=2^-2), perturb-df64 (2^-2..2^-112), CPU below. df64
    naive + f32 perturb shaders also built & validated, kept as options.
  - KEY FINDING: f32 perturbation silently breaks at the viewer's real maxIter
    (10-30% boundary error) — the f32 reference reconstruction carries ~2^-24
    error that amplifies on chaotic pixels. df64 (reference AND deltas) fixes it
    to 0-1.2% mism / meanΔsn<1 (the residual = 46- vs 53-bit gap, confirmed
    precision-not-bug by the BigInt arbiter). VALIDATE ON BULK METRICS, NOT MAX.
  - Headless WebGL2 works via SwiftShader (EXT_color_buffer_float, RGBA32F, 8192
    tex) so GPU-vs-oracle runs in CI. New: src/gpu/{glsl,renderer,validate}.js,
    test/gpu/harness.html, tools/{validate-gpu,arbiter-gpu,probe-*,smoke-viewer}.mjs,
    test/e2e/gpu.spec.mjs. UI: GPU on/off toggle + active-renderer in debug.
  - 26 unit + 28 e2e (mobile+desktop) green; validate-gpu sweep green 2^0..2^-110.
- Spawn 1: built + VALIDATED the whole correctness core and a working viewer.
  - Math: naive oracle, BigInt fixed-point, HP reference orbit, perturbation +
    Zhuoran rebasing, reference auto-selection. 26 unit tests; perturbation
    matches BigInt-exact oracle to ±1 at 2^45/2^120/2^400 and full-pipeline deep.
  - Viewer: canvas + HP view state + pinch/pan/wheel/double-tap, 4 palettes,
    iteration slider, URL-hash bookmarks, naive(shallow)/perturb(deep) dispatch.
  - Rendering: worker POOL (compute reference once, fan row-bands across cores) +
    progressive coarse-then-fine. Full-screen deep render ~8x faster than single.
  - Tests: 18 Playwright e2e (mobile+desktop) all green. Screenshots in
    screenshots/ confirm correct home + seahorse(2^41) + spiral(2^60) renders.
  - Key finding: validate vs BigInt not naive (both double-only methods are noisy
    on ill-conditioned shallow boundary pixels). See NOTES.
  - Env: NixOS has no runnable Playwright chromium; use nix-store chromium 148 +
    --headless=new (older builds crash: no /sys/devices/system/cpu). See NOTES.
