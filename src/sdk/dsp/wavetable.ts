// Band-limited, mip-mapped wavetables. Building a bank allocates (do it once and share it); reading
// is allocation-free and works on any thread.

/** Mip levels per frame. Level m keeps harmonics 1…(256 >> m): level 0 for the lowest notes, 8 is a sine. */
export const WT_LEVELS = 9;
/** Harmonics in the richest level (k = 1…256 in a frame's Fourier series). */
export const WT_HARMONICS = 256;

/**
 * Samples per cycle of each level: at least 8 per period of its top harmonic and at least 256, so the
 * images that linear interpolation creates stay far below the harmonics (around −60 dB or lower).
 */
const SIZES = [2048, 1024, 512, 256, 256, 256, 256, 256, 256] as const;
/** Where each level starts inside a frame; every level stores one extra (wrap-around) sample. */
const OFFSETS: readonly number[] = SIZES.map((_, m) => SIZES.slice(0, m).reduce((s, n) => s + n + 1, 0));
/** Floats per frame (all levels). */
export const WT_FRAME_SIZE = SIZES.reduce((s, n) => s + n + 1, 0);

/**
 * One wavetable: a morph series of single-cycle shapes, given as Fourier series so every mip level is
 * exactly band-limited. `frame()` writes the shape at morph `position` (0–1).
 */
export interface WavetableSpec {
  /** Shown in menus. */
  name: string;
  /**
   * Writes the Fourier series of the shape at morph `position` (0–1): `sin[k]` and `cos[k]` are
   * harmonic k's sine and cosine amplitudes for k = 1…WT_HARMONICS (index 0, DC, is ignored). The
   * arrays come zeroed. `addPiecewise` and `addSampled` fill them from a shape drawn in time.
   */
  frame(position: number, sin: Float64Array, cos: Float64Array): void;
}

/**
 * A bank of wavetables, each with `frames` morph frames, each frame stored at WT_LEVELS mip levels
 * in one Float32Array (so it can live in a SharedArrayBuffer and be handed to AudioWorklet kernels
 * without copying). Every frame is normalized to a peak of 1 at its richest level.
 *
 * Reading: pick the level once per block with `WavetableBank.levelFor(cyclesPerSample)` (the richest
 * level whose top harmonic stays below Nyquist), then `sample(table, position, phase, level)`, or
 * use `WavetableOscillator`.
 */
export class WavetableBank {
  private constructor(
    readonly data: Float32Array,
    readonly tables: number,
    readonly frames: number,
  ) {}

  /**
   * Builds a bank from table specs (~1 ms per table and frame count of 16 on a laptop). With
   * `shared` (and a cross-origin isolated page) the data lives in a SharedArrayBuffer.
   */
  static build(specs: readonly WavetableSpec[], frames = 16, shared = false): WavetableBank {
    const count = specs.length * frames * WT_FRAME_SIZE;
    const canShare =
      shared &&
      typeof SharedArrayBuffer !== 'undefined' &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    const data = new Float32Array(canShare ? new SharedArrayBuffer(count * 4) : new ArrayBuffer(count * 4));
    const sin = new Float64Array(WT_HARMONICS + 1);
    const cos = new Float64Array(WT_HARMONICS + 1);
    const re = new Float64Array(SIZES[0]);
    const im = new Float64Array(SIZES[0]);
    specs.forEach((spec, t) => {
      for (let f = 0; f < frames; f++) {
        sin.fill(0);
        cos.fill(0);
        spec.frame(frames > 1 ? f / (frames - 1) : 0, sin, cos);
        const base = (t * frames + f) * WT_FRAME_SIZE;
        for (let m = 0; m < WT_LEVELS; m++) synthesize(sin, cos, m, data, base + (OFFSETS[m] as number), re, im);
        // Normalize the frame to a peak of 1 at its richest level.
        let peak = 0;
        for (let i = 0; i < SIZES[0]; i++) peak = Math.max(peak, Math.abs(data[base + i] as number));
        if (peak > 0) for (let i = 0; i < WT_FRAME_SIZE; i++) data[base + i] = (data[base + i] as number) / peak;
      }
    });
    return new WavetableBank(data, specs.length, frames);
  }

  /** A bank around data built elsewhere (e.g. received by a kernel from its main-thread side). */
  static wrap(data: Float32Array, tables: number, frames: number): WavetableBank {
    if (data.length < tables * frames * WT_FRAME_SIZE) throw new Error('wavetable data is too short');
    return new WavetableBank(data, tables, frames);
  }

  /**
   * The mip level for a frequency in cycles per sample (Hz / sampleRate): the richest level whose
   * highest harmonic stays below Nyquist. Pass the highest frequency the block can reach.
   */
  static levelFor(cyclesPerSample: number): number {
    const x = 512 * Math.abs(cyclesPerSample);
    if (!(x > 1)) return 0;
    const m = Math.ceil(Math.log2(x));
    return m >= WT_LEVELS - 1 ? WT_LEVELS - 1 : m;
  }

  /** Highest harmonic kept by a level. */
  static harmonics(level: number): number {
    return WT_HARMONICS >> level;
  }

  /** Samples per cycle of a level (each level stores one more, a copy of the first, for interpolation). */
  static size(level: number): number {
    return SIZES[level] as number;
  }

  /** Index in `data` of the first sample of (table, frame, level). */
  offset(table: number, frame: number, level: number): number {
    return (table * this.frames + frame) * WT_FRAME_SIZE + (OFFSETS[level] as number);
  }

  /** The band-limited value at `phase` (cycles) of `table` morphed to `position` (0–1). */
  sample(table: number, position: number, phase: number, level: number): number {
    const d = this.data;
    const fpos = (position < 0 ? 0 : position > 1 ? 1 : position) * (this.frames - 1);
    const f0 = Math.floor(fpos);
    const f1 = f0 + 1 < this.frames ? f0 + 1 : f0;
    const morph = fpos - f0;
    const n = SIZES[level] as number;
    const x = (phase - Math.floor(phase)) * n;
    const i = Math.floor(x);
    const fr = x - i;
    const o0 = this.offset(table, f0, level) + i;
    const o1 = this.offset(table, f1, level) + i;
    const a = (d[o0] as number) + ((d[o0 + 1] as number) - (d[o0] as number)) * fr;
    const b = (d[o1] as number) + ((d[o1 + 1] as number) - (d[o1] as number)) * fr;
    return a + (b - a) * morph;
  }

  /** One cycle of `table` at `position`, `out.length` points (for drawing). */
  shape(table: number, position: number, out: Float32Array, level = 3): void {
    for (let i = 0; i < out.length; i++) out[i] = this.sample(table, position, i / out.length, level);
  }
}

/**
 * A phase accumulator reading a bank (convenience; plugins with many voices usually inline this).
 * `next(table, position, cyclesPerSample)` returns the value and advances.
 */
export class WavetableOscillator {
  phase = 0;

  constructor(public bank: WavetableBank | null = null) {}

  reset(phase = 0): void {
    this.phase = phase - Math.floor(phase);
  }

  next(table: number, position: number, cyclesPerSample: number): number {
    const bank = this.bank;
    if (!bank) return 0;
    const y = bank.sample(table, position, this.phase, WavetableBank.levelFor(cyclesPerSample));
    let ph = this.phase + cyclesPerSample;
    ph -= Math.floor(ph);
    this.phase = ph;
    return y;
  }
}

// ---------------------------------------------------------------------------------------------
// Fourier series of shapes drawn in time.

/**
 * Adds `gain` × the exact Fourier series of a periodic piecewise-linear shape (no aliasing at any
 * level). `points` is flat `[t0, y0, t1, y1, …]` with t from 0 to 1, never decreasing; the shape is a
 * straight line between neighbours, and a repeated t makes a vertical jump (the end wraps to the start).
 * A falling saw is `[0, 1, 1, -1]`, a square `[0, 1, 0.5, 1, 0.5, -1, 1, -1]`.
 */
export function addPiecewise(points: ArrayLike<number>, sin: Float64Array, cos: Float64Array, gain = 1): void {
  const harmonics = Math.min(sin.length, cos.length) - 1;
  const n = points.length >> 1;
  for (let k = 1; k <= harmonics; k++) {
    const w = 2 * Math.PI * k;
    const w2 = w * w;
    let fr = 0;
    let fi = 0;
    for (let j = 0; j + 1 < n; j++) {
      const a = points[2 * j] as number;
      const ya = points[2 * j + 1] as number;
      const b = points[2 * j + 2] as number;
      const yb = points[2 * j + 3] as number;
      if (!(b > a)) continue;
      const m = (yb - ya) / (b - a);
      const ca = Math.cos(w * a);
      const sa = Math.sin(w * a);
      const cb = Math.cos(w * b);
      const sb = Math.sin(w * b);
      // ∫ (ya + m(t − a)) e^(−iwt) dt over [a, b] = (i/w)(yb·E(b) − ya·E(a)) + (m/w²)(E(b) − E(a)).
      const xr = yb * cb - ya * ca;
      const xi = -yb * sb + ya * sa;
      fr += -xi / w + (m / w2) * (cb - ca);
      fi += xr / w + (m / w2) * (sa - sb);
    }
    cos[k] = (cos[k] as number) + gain * 2 * fr;
    sin[k] = (sin[k] as number) - gain * 2 * fi;
  }
}

const SAMPLED = 8192;

/**
 * Adds `gain` × the Fourier series of `shape(phase)` (phase 0–1), sampled at 8192 points. Use it for
 * smooth shapes (curves, phase distortion); shapes with jumps alias slightly at the top harmonics,
 * so draw those with `addPiecewise`.
 */
export function addSampled(shape: (phase: number) => number, sin: Float64Array, cos: Float64Array, gain = 1): void {
  const re = new Float64Array(SAMPLED);
  const im = new Float64Array(SAMPLED);
  for (let i = 0; i < SAMPLED; i++) re[i] = shape(i / SAMPLED);
  fft(re, im, SAMPLED, false);
  const harmonics = Math.min(sin.length, cos.length) - 1;
  for (let k = 1; k <= harmonics && k < SAMPLED / 2; k++) {
    cos[k] = (cos[k] as number) + (gain * 2 * (re[k] as number)) / SAMPLED;
    sin[k] = (sin[k] as number) - (gain * 2 * (im[k] as number)) / SAMPLED;
  }
}

/** Writes level `m` of a frame (SIZES[m] samples plus the wrap-around copy) at `out[at…]`. */
function synthesize(
  sin: Float64Array,
  cos: Float64Array,
  m: number,
  out: Float32Array,
  at: number,
  re: Float64Array,
  im: Float64Array,
): void {
  const n = SIZES[m] as number;
  const h = Math.min(WT_HARMONICS >> m, n / 2 - 1);
  re.fill(0, 0, n);
  im.fill(0, 0, n);
  // x[i] = Σ cos[k]·cos(2πki/n) + sin[k]·sin(2πki/n) = Σ X[k]·e^(2πiki/n) with X[±k] = (cos[k] ∓ i·sin[k]) / 2.
  for (let k = 1; k <= h; k++) {
    const c = (cos[k] as number) / 2;
    const s = (sin[k] as number) / 2;
    re[k] = c;
    im[k] = -s;
    re[n - k] = c;
    im[n - k] = s;
  }
  fft(re, im, n, true);
  for (let i = 0; i < n; i++) out[at + i] = re[i] as number;
  out[at + n] = re[0] as number;
}

// ---------------------------------------------------------------------------------------------
// A small radix-2 FFT for building and editing tables (`wavetable-frames.ts` shares it).

interface Plan {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const plans = new Map<number, Plan>();

function plan(n: number): Plan {
  let p = plans.get(n);
  if (p) return p;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  p = { cos, sin, rev };
  plans.set(n, p);
  return p;
}

/** In-place complex FFT of size n (a power of two); `inverse` uses e^(+i) and does not scale. */
export function fft(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i] as number;
    if (j > i) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step] as number;
        const wi = sign * (sin[k * step] as number);
        const a = start + k;
        const b = a + half;
        const br = re[b] as number;
        const bi = im[b] as number;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        const ar = re[a] as number;
        const ai = im[a] as number;
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
      }
    }
  }
}
