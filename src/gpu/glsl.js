// glsl.js — GLSL ES 3.00 (WebGL2) shader sources for the GPU Mandelbrot engines.
//
// Three fragment programs are produced here:
//   - naive  (float32)      : escape-time, shallow zoom (radius >= ~2^-22)
//   - naive  (df64)         : escape-time in double-single, medium zoom (~2^-44)
//   - perturb(float32)      : delta iteration + Zhuoran rebasing, deep zoom
//   - color                 : map the smooth-count float texture -> RGBA via a LUT
//
// All escape shaders write a vec4 into an RGBA32F attachment:
//   .r = smooth count sn  (-1.0 == interior / did-not-escape)
//   .g = integer iteration n (for debug / glitch overlay)
//   .b = glitch flag (perturb only; 1.0 == Pauldelbrot glitch suspected)
//   .a = 1.0
//
// The coordinate mapping is the single source of truth and is mirrored in JS for
// validation:  c = uOrigin + gl_FragCoord.xy * uScale   (gl_FragCoord = texel+0.5)
// so a test can recompute the exact c for any texel and compare to the CPU oracle.

// Fullscreen-triangle vertex shader (shared by every program).
export const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Double-single (df64) arithmetic on vec2(hi,lo); value = hi + lo with
// |lo| <= 0.5 ulp(hi). Standard GPU technique (Thall / Thasler).
//
// CRITICAL (Spawn 8 — found only once a REAL GPU was used; SwiftShader hid it):
// the Dekker/Veltkamp error terms rely on EXACT IEEE-754 float32 ops and are
// catastrophically fragile to the compiler's freedom to reassociate FP and to
// contract a*b±c into FMA. The NVIDIA ANGLE compiler (BOTH the Vulkan and the
// native-GLES backends) applies the algebraically-valid-but-FP-invalid identity
// `ca - (ca - x) -> x`, which zeroes the split (a_lo == 0) and collapses the WHOLE
// df64 to plain float32 (~24-bit) — silently, so the fractal just goes wrong deep.
// GLSL ES 3.00 (WebGL2) has neither the `precise` qualifier (3.20+) nor `fma`, so
// the only portable defense is an OPTIMIZATION BARRIER on every rounded result:
// `ob(x)` round-trips x through the integer domain, XOR-ing with uOptBarrier (a
// uniform == 0 the compiler cannot prove is zero), which forbids reassociation /
// contraction across that point. A plain intBitsToFloat(floatBitsToInt(x)) is NOT
// enough — the compiler folds the round-trip away; the XOR-with-an-opaque-zero is
// what actually holds. Proven exact on RTX 3090 (Vulkan + GLES) by tools/probe-df64.mjs;
// a partial/minimal placement still collapses, so EVERY op result is wrapped.
// uOptBarrier must be declared + set to 0 by every program that uses these ops
// (the renderer sets it in _program()); SwiftShader is unaffected either way.
export const DF64_LIB = `
uniform int uOptBarrier;   // == 0; opaque to the optimizer (see ob() below)
float ob(float x){ return intBitsToFloat(floatBitsToInt(x) ^ uOptBarrier); }
vec2 ds_set(float a){ return vec2(a, 0.0); }
float ds_tofloat(vec2 a){ return a.x + a.y; }
vec2 ds_add(vec2 a, vec2 b){
  float s  = ob(a.x + b.x);
  float v  = ob(s - a.x);
  float e  = ob(ob(a.x - ob(s - v)) + ob(b.x - v));
  e = ob(e + ob(a.y + b.y));
  float hi = ob(s + e);
  float lo = ob(e - ob(hi - s));
  return vec2(hi, lo);
}
vec2 ds_sub(vec2 a, vec2 b){ return ds_add(a, vec2(-b.x, -b.y)); }
vec2 ds_mul(vec2 a, vec2 b){
  const float SPLIT = 4097.0;            // 2^12 + 1
  float p  = ob(a.x * b.x);
  float ca = ob(SPLIT * a.x); float a_hi = ob(ca - ob(ca - a.x)); float a_lo = ob(a.x - a_hi);
  float cb = ob(SPLIT * b.x); float b_hi = ob(cb - ob(cb - b.x)); float b_lo = ob(b.x - b_hi);
  float e = ob(ob(ob(ob(ob(a_hi*b_hi) - p) + ob(a_hi*b_lo)) + ob(a_lo*b_hi)) + ob(a_lo*b_lo));
  e = ob(e + ob(ob(a.x*b.y) + ob(a.y*b.x)));
  float hi = ob(p + e);
  float lo = ob(e - ob(hi - p));
  return vec2(hi, lo);
}
// frexp exponent of |x|: the k with |x|*2^-k in [0.5,1) for nonzero x; |x| >= 2^(k-1).
// Reads the IEEE-754 biased exponent field directly (sign masked off). For x==0 it
// returns -126 (treats 0 as the smallest normal) — callers handle 0 explicitly.
// Used by the perturb fast-skip (cheap magnitude exponent) and by FE_LIB.
int ilogb1(float x){ return ((floatBitsToInt(x) & 0x7fffffff) >> 23) - 126; }
// Multiply a df64 by 2^p EXACTLY (both hi and lo), for the rescaled perturb engine.
// p < -100 returns 0: a term scaled that far below an O(1) frame is below df64's
// ~46-bit precision (dropped by the next ds_add anyway) — and the cutoff keeps every
// scale factor a normal float (no subnormal, since our mantissas have |hi| ~ O(1)).
vec2 ds_scale2(vec2 a, int p){
  if (p < -100) return vec2(0.0);
  float s = intBitsToFloat((p + 127) << 23);
  return a * s;
}
`;

// floatexp ("fe") library: a real value is  m * 2^e  where m is a df64 (vec2
// hi+lo, ~46-bit) normalized so |m.x| in [0.5,1), and e is an int. This extends
// the df64 mantissa with an unbounded exponent, so the per-pixel deltas dc, dz —
// which are ~2^-270 at deep zoom and would UNDERFLOW float32 (min normal 2^-126),
// flooring the plain-df64 perturb path at ~2^-112 — keep full precision. The
// reference orbit Z stays df64 (it is O(1)); only the small deltas use fe.
//
// Relies only on the df64 ds_* ops + IEEE-754 bit reinterpretation (WebGL2's
// floatBitsToInt / intBitsToFloat). Depends on DF64_LIB being included first.
//
// PERF: normalization used to estimate the binary exponent with log2() and apply
// it with exp2() — two software transcendentals per fe_norm, and fe_add called
// exp2 three more times. The hot perturbation loop runs ~20 fe ops per pixel-
// iteration, so that was ~60+ transcendental calls/iteration — the dominant cost
// on a software rasterizer (SwiftShader). fe_pow2/fe_ilogb1 below do the same job
// by reading and writing the float's exponent field directly: exact (no ±1 log2
// rounding, so no correction step and no vendor-approx "sparkle" risk on mobile)
// and far cheaper. Valid because our mantissas stay in [~2^-50, 2], so every
// exponent we touch is well inside the normal-float range [-126,127].
const FE_LIB = `
struct fe { vec2 m; int e; };
const int FE_ZERO_E = -100000;          // exponent sentinel for the value 0

// 2^k as an exact float, built straight into the IEEE-754 exponent field
// (replaces exp2). k must be in [-126,127] — true for every k we feed it.
float fe_pow2(int k){ return intBitsToFloat((k + 127) << 23); }
// frexp exponent: the k with |x|*2^-k in [0.5,1), for nonzero x (replaces log2).
// Shared bit-twiddle lives in DF64_LIB (ilogb1), included before FE_LIB.
int fe_ilogb1(float x){ return ilogb1(x); }

fe fe_norm(vec2 m, int e){
  if (m.x == 0.0) return fe(vec2(0.0), FE_ZERO_E);
  int k = fe_ilogb1(m.x);                // exact: |m.x|*2^-k lands in [0.5,1)
  return fe(m * fe_pow2(-k), e + k);     // power-of-two scale is exact for hi AND lo
}
fe   fe_fromds(vec2 d){ return fe_norm(d, 0); }
fe   fe_fromf(float f){ return fe_norm(vec2(f, 0.0), 0); }
// value = (hi+lo)*2^e. For very negative e the value is far below O(1) and
// negligible against the O(1) reference when converted to a float — return 0
// (fe_pow2 only covers e >= -126; below that it would underflow to 0 anyway).
float fe_tof(fe a){
  if (a.e < -126) return 0.0;
  float s = fe_pow2(a.e);
  return a.m.x * s + a.m.y * s;
}
fe   fe_neg(fe a){ return fe(vec2(-a.m.x, -a.m.y), a.e); }
fe   fe_dbl(fe a){ if (a.m.x == 0.0) return a; return fe(a.m, a.e + 1); }

fe fe_add(fe a, fe b){
  if (a.m.x == 0.0) return b;
  if (b.m.x == 0.0) return a;
  int E = a.e >= b.e ? a.e : b.e;
  if (E - a.e > 52) return b;           // a negligible beside b
  if (E - b.e > 52) return a;           // b negligible beside a
  vec2 am = a.m * fe_pow2(a.e - E);     // scale to common exponent (exact, <= 1)
  vec2 bm = b.m * fe_pow2(b.e - E);
  return fe_norm(ds_add(am, bm), E);
}
fe fe_sub(fe a, fe b){ return fe_add(a, fe_neg(b)); }
fe fe_mul(fe a, fe b){
  if (a.m.x == 0.0 || b.m.x == 0.0) return fe(vec2(0.0), FE_ZERO_E);
  return fe_norm(ds_mul(a.m, b.m), a.e + b.e);
}
fe fe_mulds(fe a, vec2 d){              // fe * arbitrary df64 (e.g. reference Z)
  if (a.m.x == 0.0 || d.x == 0.0) return fe(vec2(0.0), FE_ZERO_E);
  return fe_norm(ds_mul(a.m, d), a.e);
}
// magnitude compare for NON-NEGATIVE fe (squared magnitudes): is a < b ?
bool fe_lt(fe a, fe b){
  if (a.m.x == 0.0) return (b.m.x != 0.0);
  if (b.m.x == 0.0) return false;
  if (a.e != b.e) return a.e < b.e;
  if (a.m.x != b.m.x) return a.m.x < b.m.x;
  return a.m.y < b.m.y;
}
`;

// Smooth-count helper — bit-identical to naive.js / perturb.js:
//   logZn = 0.5*ln(mag2);  nu = log2(logZn / ln2);  sn = n + 1 - nu
const SMOOTH = `
float smoothCount(float n, float mag2){
  float logZn = 0.5 * log(mag2);
  float nu = log(logZn / 0.6931471805599453) / 0.6931471805599453;
  return n + 1.0 - nu;
}
`;

// Build the naive escape shader. df64=true -> double-single coordinates.
export function naiveFrag(df64) {
  const typedefs = df64
    ? `#define REAL vec2
       #define R(x) ds_set(x)
       #define ADD(a,b) ds_add(a,b)
       #define SUB(a,b) ds_sub(a,b)
       #define MUL(a,b) ds_mul(a,b)
       #define TOF(a) ds_tofloat(a)`
    : `#define REAL float
       #define R(x) (x)
       #define ADD(a,b) ((a)+(b))
       #define SUB(a,b) ((a)-(b))
       #define MUL(a,b) ((a)*(b))
       #define TOF(a) (a)`;
  return `#version 300 es
precision highp float;
precision highp int;
${df64 ? DF64_LIB : ''}
${SMOOTH}
${typedefs}
uniform REAL uOx, uOy, uScale;   // c = (uOx,uOy) + frag.xy*uScale
uniform int  uMaxIter;
uniform float uBailoutSq;
out vec4 frag;
void main(){
  REAL fx = R(gl_FragCoord.x);
  REAL fy = R(gl_FragCoord.y);
  REAL cx = ADD(uOx, MUL(fx, uScale));
  REAL cy = ADD(uOy, MUL(fy, uScale));
  REAL zx = R(0.0), zy = R(0.0), zx2 = R(0.0), zy2 = R(0.0);
  int n = 0;
  for (int i = 0; i < 100000000; i++) {
    float m2 = TOF(ADD(zx2, zy2));
    if (n >= uMaxIter || m2 > uBailoutSq) break;
    zy = ADD(MUL(ADD(zx, zx), zy), cy);   // 2*zx*zy + cy
    zx = ADD(SUB(zx2, zy2), cx);          // zx2 - zy2 + cx
    zx2 = MUL(zx, zx);
    zy2 = MUL(zy, zy);
    n++;
  }
  float mag2 = TOF(ADD(zx2, zy2));
  if (n >= uMaxIter) { frag = vec4(-1.0, float(n), 0.0, 1.0); return; }
  frag = vec4(smoothCount(float(n), mag2), float(n), 0.0, 1.0);
}
`;
}

// Build the perturbation escape shader (float32 deltas). The reference orbit is
// sampled from an RG32F texture uRef of width uRefW: texel index n -> (Zx,Zy).
// Per-pixel delta dc = (uOx,uOy) + frag.xy*uScale (all small float32 quantities,
// valid where dc is float32-representable, i.e. radius >~ 2^-100).
export function perturbFrag() {
  return `#version 300 es
precision highp float;
precision highp int;
${SMOOTH}
uniform sampler2D uRef;     // RG32F: (Zx, Zy) per iteration index
uniform int uRefW;          // texture width (texels per row)
uniform int uRefLen;        // number of valid reference iterations (z_0..z_len)
uniform float uOx, uOy, uScale;  // dc = (uOx,uOy) + frag.xy*uScale
uniform int uMaxIter;
uniform float uBailoutSq;
uniform float uGlitchTol;   // Pauldelbrot tol (e.g. 1e-6), 0 to disable
out vec4 frag;

vec2 refZ(int m){
  int x = m % uRefW;
  int y = m / uRefW;
  return texelFetch(uRef, ivec2(x, y), 0).rg;
}

void main(){
  float dcx = uOx + gl_FragCoord.x * uScale;
  float dcy = uOy + gl_FragCoord.y * uScale;
  float dx = 0.0, dy = 0.0;   // dz relative to Z_m
  int m = 0;                  // reference index
  int n = 0;
  float glitch = 0.0;
  vec2 Z = refZ(0);           // Z[m] carried across iterations (one fetch per iter)
  for (int i = 0; i < 100000000; i++) {
    if (n >= uMaxIter) break;
    // Z = Z[m].  dz' = 2*Z_m*dz + dz^2 + dc
    float ndx = 2.0*(Z.x*dx - Z.y*dy) + (dx*dx - dy*dy) + dcx;
    float ndy = 2.0*(Z.x*dy + Z.y*dx) + (2.0*dx*dy) + dcy;
    dx = ndx; dy = ndy;
    m++; n++;
    Z = refZ(m);              // now Z[m] (= Zm for z = Zm + dz)
    float zfx = Z.x + dx;     // true value z = Z_m + dz
    float zfy = Z.y + dy;
    float mag2 = zfx*zfx + zfy*zfy;
    if (mag2 > uBailoutSq) {
      frag = vec4(smoothCount(float(n), mag2), float(n), glitch, 1.0);
      return;
    }
    float dz2 = dx*dx + dy*dy;
    bool rebase = (mag2 < dz2) || (m == uRefLen);
    if (uGlitchTol > 0.0 && !rebase) {
      float zref2 = Z.x*Z.x + Z.y*Z.y;
      if (zref2 > 0.0 && mag2 < uGlitchTol * zref2) glitch = 1.0;
    }
    if (rebase) { dx = zfx; dy = zfy; m = 0; Z = refZ(0); }
  }
  frag = vec4(-1.0, float(n), glitch, 1.0);   // interior
}
`;
}

// df64 perturbation: like perturbFrag but the reference orbit AND the deltas are
// double-single (~46-bit). Fixes the f32 breakdown at high maxIter (the f32
// reference's ~2^-24 reconstruction error amplifies on chaotic high-count
// pixels). Reference texture is RGBA32F: (Zx.hi, Zx.lo, Zy.hi, Zy.lo).
export function perturbFragDf64() {
  return `#version 300 es
precision highp float;
precision highp int;
${DF64_LIB}
${SMOOTH}
uniform sampler2D uRef;
uniform int uRefW, uRefLen, uMaxIter;
uniform vec2 uOx, uOy, uScale;   // df64 dc origin + per-pixel step
uniform float uBailoutSq;
uniform float uGlitchTol;
uniform int uFastSkip;           // 1 = skip the provably-inert escape/rebase block
out vec4 frag;

void getZ(int m, out vec2 Zx, out vec2 Zy){
  vec4 v = texelFetch(uRef, ivec2(m % uRefW, m / uRefW), 0);
  Zx = v.xy; Zy = v.zw;
}

void main(){
  vec2 dcx = ds_add(uOx, ds_mul(ds_set(gl_FragCoord.x), uScale));
  vec2 dcy = ds_add(uOy, ds_mul(ds_set(gl_FragCoord.y), uScale));
  vec2 dx = ds_set(0.0), dy = ds_set(0.0);
  int m = 0, n = 0;
  float glitch = 0.0;
  // Z[m] is carried across iterations: the Z[m+1] fetched for the z=Z+dz test below
  // IS the next iteration's Z[m], so we fetch the reference once per iteration (plus
  // a re-fetch of Z[0] on rebase) instead of twice. Bit-identical to a per-iter fetch.
  vec2 Zx, Zy; getZ(0, Zx, Zy);
  for (int i = 0; i < 100000000; i++) {
    if (n >= uMaxIter) break;
    // Zx,Zy = Z[m].   dz' = 2*Z*dz + dz^2 + dc
    vec2 t1 = ds_sub(ds_mul(Zx, dx), ds_mul(Zy, dy));   // Zx*dx - Zy*dy
    vec2 t2 = ds_add(ds_mul(Zx, dy), ds_mul(Zy, dx));   // Zx*dy + Zy*dx
    vec2 sx = ds_sub(ds_mul(dx, dx), ds_mul(dy, dy));   // dx^2 - dy^2
    vec2 sy = ds_mul(dx, dy);                           // dx*dy
    vec2 ndx = ds_add(ds_add(ds_add(t1, t1), sx), dcx);            // 2*t1 + sx + dc
    vec2 ndy = ds_add(ds_add(ds_add(t2, t2), ds_add(sy, sy)), dcy);// 2*t2 + 2*sy + dc
    dx = ndx; dy = ndy;
    m++; n++;
    getZ(m, Zx, Zy);                                    // now Z[m] (= Zm for z = Zm+dz)
    // Fast skip (bit-identical): when dz is far below the O(1) reference Z_m, the
    // true value z = Z_m + dz can neither escape (|z| <= |Z_m|+|dz| << bailout) nor
    // rebase (|z| >= |Z_m|-|dz| > |dz|), and the Pauldelbrot glitch test is false
    // (mag2 ~ |Z_m|^2). So the whole escape/rebase/glitch block leaves state
    // unchanged — skip it. |dz| < 2^(sdz+1); |Z_m| >= 2^(ezm-1); ezm >= sdz+4 =>
    // |Z_m| > 2|dz| (no rebase); ezm <= 6 => |z| < 256 (no escape); m != uRefLen
    // keeps the forced end-of-reference rebase.
    if (uFastSkip == 1 && m != uRefLen) {
      int sdz = max(ilogb1(dx.x), ilogb1(dy.x));
      int ezm = max(ilogb1(Zx.x), ilogb1(Zy.x));
      if (ezm <= 6 && ezm >= sdz + 4) continue;
    }
    vec2 zfx = ds_add(Zx, dx);
    vec2 zfy = ds_add(Zy, dy);
    float mag2 = ds_tofloat(ds_add(ds_mul(zfx, zfx), ds_mul(zfy, zfy)));
    if (mag2 > uBailoutSq) {
      frag = vec4(smoothCount(float(n), mag2), float(n), glitch, 1.0);
      return;
    }
    float dz2 = ds_tofloat(ds_add(ds_mul(dx, dx), ds_mul(dy, dy)));
    bool rebase = (mag2 < dz2) || (m == uRefLen);
    if (uGlitchTol > 0.0 && !rebase) {
      float zref2 = ds_tofloat(ds_add(ds_mul(Zx, Zx), ds_mul(Zy, Zy)));
      if (zref2 > 0.0 && mag2 < uGlitchTol * zref2) glitch = 1.0;
    }
    if (rebase) { dx = zfx; dy = zfy; m = 0; getZ(0, Zx, Zy); }
  }
  frag = vec4(-1.0, float(n), glitch, 1.0);
}
`;
}

// floatexp perturbation: like perturbFragDf64 but the per-pixel deltas dc, dz are
// floatexp (df64 mantissa + int exponent), so the shader works below the df64
// float32-exponent floor (~2^-112) all the way down to the double exponent range
// (~2^-1000) — this is what lets the GPU render ~2^270 zooms. The reference orbit
// is the SAME df64 texture (Zx.hi,Zx.lo,Zy.hi,Zy.lo); only dc/dz carry an exponent.
// dc origin/step come in as fe: mantissa (df64 vec2) + int exponent uniforms.
export function perturbFragFloatexp() {
  return `#version 300 es
precision highp float;
precision highp int;
${DF64_LIB}
${FE_LIB}
${SMOOTH}
uniform sampler2D uRef;
uniform int uRefW, uRefLen, uMaxIter;
uniform vec2 uOxm, uOym, uScalem;   // fe mantissas (df64) of dc origin + per-pixel step
uniform int  uOxe, uOye, uScalee;   // matching fe exponents
uniform float uBailoutSq;
uniform float uGlitchTol;
uniform int uFastSkip;              // 1 = skip the provably-inert escape/rebase block
out vec4 frag;

void getZ(int m, out vec2 Zx, out vec2 Zy){
  vec4 v = texelFetch(uRef, ivec2(m % uRefW, m / uRefW), 0);
  Zx = v.xy; Zy = v.zw;
}

void main(){
  fe sc = fe(uScalem, uScalee);
  fe dcx = fe_add(fe(uOxm, uOxe), fe_mul(fe_fromf(gl_FragCoord.x), sc));
  fe dcy = fe_add(fe(uOym, uOye), fe_mul(fe_fromf(gl_FragCoord.y), sc));
  fe dx = fe(vec2(0.0), FE_ZERO_E), dy = fe(vec2(0.0), FE_ZERO_E);
  int m = 0, n = 0;
  float glitch = 0.0;
  // Z[m] carried across iterations (one reference fetch per iter; re-fetch Z[0] on
  // rebase) — the Z[m+1] needed for z=Z+dz IS next iteration's Z[m]. Bit-identical.
  vec2 Zx, Zy; getZ(0, Zx, Zy);
  for (int i = 0; i < 100000000; i++) {
    if (n >= uMaxIter) break;
    // Zx,Zy = Z[m].  dz' = 2*Z*dz + dz^2 + dc   (Z is df64, dz/dc are fe)
    fe t1 = fe_sub(fe_mulds(dx, Zx), fe_mulds(dy, Zy));   // Zx*dx - Zy*dy
    fe t2 = fe_add(fe_mulds(dy, Zx), fe_mulds(dx, Zy));   // Zx*dy + Zy*dx
    fe sx = fe_sub(fe_mul(dx, dx), fe_mul(dy, dy));       // dx^2 - dy^2
    fe sy = fe_mul(dx, dy);                               // dx*dy
    fe ndx = fe_add(fe_add(fe_dbl(t1), sx), dcx);                 // 2*t1 + sx + dc
    fe ndy = fe_add(fe_add(fe_dbl(t2), fe_dbl(sy)), dcy);         // 2*t2 + 2*sy + dc
    dx = ndx; dy = ndy;
    m++; n++;
    getZ(m, Zx, Zy);                                      // now Z[m] (= Zm)
    // Fast skip (bit-identical): when dz is far below the O(1) reference Z_m, the
    // true value z = Z_m + dz can neither escape (|z| <= |Z_m|+|dz| << bailout) nor
    // rebase (|z| >= |Z_m|-|dz| > |dz|), and the Pauldelbrot glitch test is false.
    // So the whole escape/rebase/glitch block leaves state unchanged — skip it.
    // |dz| < 2^(sdz+1); |Z_m| >= 2^(ezm-1); ezm >= sdz+4 => |Z_m| > 2|dz| (no
    // rebase); ezm <= 6 => |z| < 256 (no escape). Below the df64 floor Z_m reads 0
    // (ezm=-126) and the exact path wouldn't rebase either (z=dz, |z|=|dz| not <),
    // so the skip still matches. m != uRefLen keeps the forced end-of-ref rebase.
    if (uFastSkip == 1 && m != uRefLen) {
      int sdz = max(dx.e, dy.e);
      int ezm = max(ilogb1(Zx.x), ilogb1(Zy.x));
      if (ezm <= 6 && ezm >= sdz + 4) continue;
    }
    fe zfx = fe_add(fe_fromds(Zx), dx);                   // true z = Z_m + dz
    fe zfy = fe_add(fe_fromds(Zy), dy);
    fe mag2 = fe_add(fe_mul(zfx, zfx), fe_mul(zfy, zfy));
    float mag2f = fe_tof(mag2);
    if (mag2f > uBailoutSq) {
      frag = vec4(smoothCount(float(n), mag2f), float(n), glitch, 1.0);
      return;
    }
    fe dz2 = fe_add(fe_mul(dx, dx), fe_mul(dy, dy));
    bool rebase = fe_lt(mag2, dz2) || (m == uRefLen);
    if (uGlitchTol > 0.0 && !rebase) {
      fe zr = fe_add(fe_mul(fe_fromds(Zx), fe_fromds(Zx)), fe_mul(fe_fromds(Zy), fe_fromds(Zy)));
      if (zr.m.x != 0.0 && fe_lt(mag2, fe_mul(fe_fromf(uGlitchTol), zr))) glitch = 1.0;
    }
    if (rebase) { dx = zfx; dy = zfy; m = 0; getZ(0, Zx, Zy); }
  }
  frag = vec4(-1.0, float(n), glitch, 1.0);
}
`;
}

// Rescaled single-exponent perturbation — same depth range as the floatexp engine
// (works far below the float32 floor) but ~1.3-1.5× faster on the per-iteration UPDATE.
//
// The floatexp engine carries a SEPARATE exponent on every delta component and
// renormalizes after EVERY arithmetic op (~14 fe ops/iteration, each a normalize +
// struct/branch). Here the delta dz = (Dx,Dy)·2^S keeps df64 mantissas Dx,Dy under
// ONE shared int exponent S, so the update dz' = 2·Z·dz + dz² + dc runs in raw df64:
//   - linear  L = 2·(Zx·Dx − Zy·Dy, Zx·Dy + Zy·Dx),  exponent S       (Z is df64, O(1))
//   - quad    (Dx²−Dy², 2·Dx·Dy),                     exponent 2S      (dropped when
//             >52 bits below the frame — same point fe_add drops it; at deep zoom
//             dz²~2^-540 vs linear~2^-270 it's invisible, so this is free precision)
//   - dc      (Cx,Cy)·2^Sc                            (collapsed once before the loop)
// align all three to the frame W = max(S,Sc) with exact power-of-two scalings, sum in
// df64, and renormalize the shared exponent ONCE. The escape/rebase test still runs in
// exact floatexp (convert dz→fe per component) so the Zhuoran rebase DECISION is
// bit-for-bit the same logic as the floatexp engine — the part that needs exact
// magnitudes when the true z passes near 0 is untouched. Validated vs the CPU oracle
// (tools/validate-gpu.mjs) and cross-checked to agree with the fe engine.
export function perturbFragRescaled() {
  return `#version 300 es
precision highp float;
precision highp int;
${DF64_LIB}
${FE_LIB}
${SMOOTH}
uniform sampler2D uRef;
uniform int uRefW, uRefLen, uMaxIter;
uniform vec2 uOxm, uOym, uScalem;   // fe mantissas (df64) of dc origin + per-pixel step
uniform int  uOxe, uOye, uScalee;   // matching fe exponents
uniform float uBailoutSq;
uniform float uGlitchTol;
uniform int uFastSkip;
out vec4 frag;

const int S_ZERO = -2000000000;     // shared-exponent sentinel for dz == 0

void getZ(int m, out vec2 Zx, out vec2 Zy){
  vec4 v = texelFetch(uRef, ivec2(m % uRefW, m / uRefW), 0);
  Zx = v.xy; Zy = v.zw;
}

void main(){
  // dc = origin + frag·step (in fe), then collapse to one shared exponent Sc.
  fe sc = fe(uScalem, uScalee);
  fe dcxf = fe_add(fe(uOxm, uOxe), fe_mul(fe_fromf(gl_FragCoord.x), sc));
  fe dcyf = fe_add(fe(uOym, uOye), fe_mul(fe_fromf(gl_FragCoord.y), sc));
  int Sc = max(dcxf.e, dcyf.e);
  vec2 Cx = ds_scale2(dcxf.m, dcxf.e - Sc);   // dc = (Cx,Cy)·2^Sc
  vec2 Cy = ds_scale2(dcyf.m, dcyf.e - Sc);

  vec2 Dx = vec2(0.0), Dy = vec2(0.0);        // dz = (Dx,Dy)·2^S
  int S = S_ZERO;
  int m = 0, n = 0;
  float glitch = 0.0;
  vec2 Zx, Zy; getZ(0, Zx, Zy);
  for (int i = 0; i < 100000000; i++) {
    if (n >= uMaxIter) break;
    // ---- rescaled delta update: dz' = 2·Z·dz + dz² + dc ----
    if (S == S_ZERO) {                        // dz == 0  ->  dz' = dc
      Dx = Cx; Dy = Cy; S = Sc;
    } else {
      vec2 lx = ds_sub(ds_mul(Zx, Dx), ds_mul(Zy, Dy));   // Zx·Dx − Zy·Dy
      vec2 ly = ds_add(ds_mul(Zx, Dy), ds_mul(Zy, Dx));   // Zx·Dy + Zy·Dx
      lx = ds_scale2(lx, 1); ly = ds_scale2(ly, 1);       // ·2  (linear ≈ 2·Z·dz, exponent S)
      // The combine frame W must reflect each term's TRUE exponent. The linear term's
      // is eL = S + (its mantissa's ilogb): using S alone lets the un-normalized linear
      // (|2·Z·D| up to ~6) inflate the frame and cost the dc/dz² addends ~2-3 low bits
      // vs the floatexp engine. The dz² exponent qe = 2S must also be in W: when the
      // reference Z_m ≈ 0 (exactly so at m=0 after every rebase, since Z_0=0) the linear
      // vanishes and dz² is DOMINANT (dz' = dz² + dc); leaving qe out lets a vanished
      // linear (ilogb1(0) = -126) pick a bogus frame that mis-scales dz², so the orbit
      // never escapes. (Scaling lx by 2^(S-W) folds the normalization in — no separate step.)
      int eL = S + max(ilogb1(lx.x), ilogb1(ly.x));
      int qe = S + S;                                     // dz² exponent
      int W = max(max(eL, qe), Sc);
      // Accumulate (linear + dz²) + dc, matching the floatexp engine's add order.
      vec2 ax = ds_scale2(lx, S - W);
      vec2 ay = ds_scale2(ly, S - W);
      if (qe - W > -52) {                                 // else dz² negligible (as fe_add)
        vec2 qx = ds_sub(ds_mul(Dx, Dx), ds_mul(Dy, Dy));
        vec2 qy = ds_scale2(ds_mul(Dx, Dy), 1);           // 2·Dx·Dy
        ax = ds_add(ax, ds_scale2(qx, qe - W));
        ay = ds_add(ay, ds_scale2(qy, qe - W));
      }
      ax = ds_add(ax, ds_scale2(Cx, Sc - W));
      ay = ds_add(ay, ds_scale2(Cy, Sc - W));
      if (ax.x == 0.0 && ay.x == 0.0) { Dx = vec2(0.0); Dy = vec2(0.0); S = S_ZERO; }
      else {
        int k = max(ilogb1(ax.x), ilogb1(ay.x));          // larger component -> [0.5,1)
        Dx = ds_scale2(ax, -k); Dy = ds_scale2(ay, -k); S = W + k;
      }
    }
    m++; n++;
    getZ(m, Zx, Zy);
    // Fast skip (same proof as the fe engine; |dz| < 2^(S+1), |Z_m| >= 2^(ezm-1)).
    if (uFastSkip == 1 && m != uRefLen) {
      int ezm = max(ilogb1(Zx.x), ilogb1(Zy.x));
      if (ezm <= 6 && ezm >= S + 4) continue;
    }
    // ---- exact escape / rebase in floatexp (identical logic to perturbFragFloatexp) ----
    fe dxf = fe_norm(Dx, S);     // S==S_ZERO -> Dx==0 -> fe zero (e ignored)
    fe dyf = fe_norm(Dy, S);
    fe zfx = fe_add(fe_fromds(Zx), dxf);
    fe zfy = fe_add(fe_fromds(Zy), dyf);
    fe mag2 = fe_add(fe_mul(zfx, zfx), fe_mul(zfy, zfy));
    float mag2f = fe_tof(mag2);
    if (mag2f > uBailoutSq) {
      frag = vec4(smoothCount(float(n), mag2f), float(n), glitch, 1.0);
      return;
    }
    fe dz2 = fe_add(fe_mul(dxf, dxf), fe_mul(dyf, dyf));
    bool rebase = fe_lt(mag2, dz2) || (m == uRefLen);
    if (uGlitchTol > 0.0 && !rebase) {
      fe zr = fe_add(fe_mul(fe_fromds(Zx), fe_fromds(Zx)), fe_mul(fe_fromds(Zy), fe_fromds(Zy)));
      if (zr.m.x != 0.0 && fe_lt(mag2, fe_mul(fe_fromf(uGlitchTol), zr))) glitch = 1.0;
    }
    if (rebase) {                // dz = z; re-collapse z (fe per component) to shared form
      int Sz = max(zfx.e, zfy.e);
      if (zfx.m.x == 0.0 && zfy.m.x == 0.0) { Dx = vec2(0.0); Dy = vec2(0.0); S = S_ZERO; }
      else { Dx = ds_scale2(zfx.m, zfx.e - Sz); Dy = ds_scale2(zfy.m, zfy.e - Sz); S = Sz; }
      m = 0; getZ(0, Zx, Zy);
    }
  }
  frag = vec4(-1.0, float(n), glitch, 1.0);
}
`;
}

// Color pass: sample the smooth-count texture + a 1-D palette LUT -> RGBA8 canvas.
// Mirrors palette.colorFor: t = sn/uCycle + uShift; rgb = LUT(fract(t)); sn<0 -> interior.
//
// Supersampling: the sn texture is rendered at uSS× the output resolution. Each
// output pixel box-averages the COLORS of its uSS×uSS subsamples (averaging the
// final RGB, not the cyclic smooth-count sn — averaging sn would bleed hues where
// the palette wraps). uSS=1 reduces to a plain point sample (old behavior).
export const COLOR_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSn;       // RGBA32F (compute res = uSS * output): .r = smooth count
uniform sampler2D uPalette;  // 1xN RGBA8 gradient (LINEAR, REPEAT)
uniform float uCycle;
uniform float uShift;
uniform vec3 uInterior;
uniform int uSS;             // supersample factor (>= 1)
out vec4 frag;

vec3 colorOf(float sn){
  if (sn < 0.0) return uInterior;          // interior / did-not-escape
  float t = sn / uCycle + uShift;
  return texture(uPalette, vec2(fract(t), 0.5)).rgb;
}

void main(){
  // Flip Y: the iteration shaders write sn bottom-up; output pixel (xo,yo) (GL,
  // bottom-up) maps to the compute block whose top row is csize.y-(yo+1)*uSS.
  // For uSS=1 this is csize.y-1-yo, matching the original point-sampled mapping.
  ivec2 csize = textureSize(uSn, 0);       // (cW, cH) compute resolution
  int bx = int(gl_FragCoord.x) * uSS;
  int by = csize.y - (int(gl_FragCoord.y) + 1) * uSS;
  vec3 acc = vec3(0.0);
  for (int sy = 0; sy < uSS; sy++) {
    for (int sx = 0; sx < uSS; sx++) {
      acc += colorOf(texelFetch(uSn, ivec2(bx + sx, by + sy), 0).r);
    }
  }
  frag = vec4(acc / float(uSS * uSS), 1.0);
}
`;
