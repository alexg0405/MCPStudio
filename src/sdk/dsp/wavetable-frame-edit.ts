// Editing frames: drawing, smoothing, morphing and the other operations on a frame. Every function returns a new
// frame (or fills the buffer it is given) and leaves its input alone.
import { clamp } from './math';
import { FRAME_HARMONICS, cloneFrame, newFrame, peakOf, type Frame } from './wavetable-frame';

// ---------------------------------------------------------------------------------------------
// Editing. Every function returns a new frame (or fills the buffer it is given) and leaves its input alone.

/**
 * Draws a straight stroke into a drawing buffer of one cycle: from (x0, y0) to (x1, y1), x as a fraction of the cycle
 * (0–1) and y from −1 to 1. Strokes may go either way; every point between the two is set.
 */
export function drawStroke(wave: Float32Array, x0: number, y0: number, x1: number, y1: number): void {
  const n = wave.length;
  const i0 = Math.round(clamp(x0, 0, 1) * (n - 1));
  const i1 = Math.round(clamp(x1, 0, 1) * (n - 1));
  const a = clamp(y0, -1, 1);
  const b = clamp(y1, -1, 1);
  if (i0 === i1) {
    wave[i1] = b;
    return;
  }
  const step = i1 > i0 ? 1 : -1;
  for (let i = i0; ; i += step) {
    wave[i] = a + ((b - a) * (i - i0)) / (i1 - i0);
    if (i === i1) break;
  }
}

/** Softens the shape: a Gaussian low-pass on the harmonics. `amount` 0–1 (1 leaves harmonic 12 at 60 %, 40+ gone). */
export function smoothFrame(f: Frame, amount: number): Frame {
  const out = cloneFrame(f);
  const sigma = clamp(amount, 0, 1) * 0.1;
  for (let k = 1; k <= FRAME_HARMONICS; k++) {
    const g = Math.exp(-0.5 * (k * sigma) ** 2);
    out.sin[k] = (f.sin[k] as number) * g;
    out.cos[k] = (f.cos[k] as number) * g;
  }
  return out;
}

/** Scales the frame so its highest peak is `peak` (default 1); a silent frame stays silent. */
export function normalizeFrame(f: Frame, peak = 1): Frame {
  const p = peakOf(f);
  const out = cloneFrame(f);
  if (!(p > 1e-9)) return out;
  const g = peak / p;
  for (let k = 0; k <= FRAME_HARMONICS; k++) {
    out.sin[k] = (out.sin[k] as number) * g;
    out.cos[k] = (out.cos[k] as number) * g;
  }
  return out;
}

/** Clears the DC offset (the shape then rises and falls equally around zero). */
export function removeDc(f: Frame): Frame {
  const out = cloneFrame(f);
  out.cos[0] = 0;
  return out;
}

/**
 * Brick-wall low-pass in the frequency domain: harmonics above `maxHarmonic` are removed (a mouse-drawn corner or an
 * imported edge brings very high harmonics that only add hiss). With `taper`, the last `taper` harmonics fade out
 * with a raised cosine instead of stopping at once (less ringing around jumps).
 */
export function bandLimit(f: Frame, maxHarmonic: number, taper = 0): Frame {
  const out = cloneFrame(f);
  const top = clamp(Math.round(maxHarmonic), 1, FRAME_HARMONICS);
  const t = Math.max(0, Math.min(Math.round(taper), top - 1));
  for (let k = 1; k <= FRAME_HARMONICS; k++) {
    let g = 1;
    if (k > top) g = 0;
    else if (t > 0 && k > top - t) g = 0.5 * (1 + Math.cos((Math.PI * (k - (top - t))) / (t + 1)));
    out.sin[k] = (f.sin[k] as number) * g;
    out.cos[k] = (f.cos[k] as number) * g;
  }
  return out;
}

/** A frame of sines with these strengths: `amps[0]` is the fundamental, `amps[1]` the 2nd harmonic, and so on. */
export function frameFromHarmonics(amps: ArrayLike<number>): Frame {
  const f = newFrame();
  for (let k = 1; k <= FRAME_HARMONICS && k <= amps.length; k++) {
    const a = Number(amps[k - 1]);
    f.sin[k] = Number.isFinite(a) ? Math.max(0, a) : 0;
  }
  return f;
}

/** Sets the strength of harmonic `k`, keeping its phase (a silent harmonic starts as a sine). */
export function setHarmonic(f: Frame, k: number, amp: number): Frame {
  const out = cloneFrame(f);
  if (k < 1 || k > FRAME_HARMONICS) return out;
  const a = Math.max(0, amp);
  const mag = Math.hypot(f.sin[k] as number, f.cos[k] as number);
  if (mag < 1e-12) {
    out.sin[k] = a;
    out.cos[k] = 0;
  } else {
    out.sin[k] = ((f.sin[k] as number) * a) / mag;
    out.cos[k] = ((f.cos[k] as number) * a) / mag;
  }
  return out;
}

/** Turns the shape upside down (the polarity of every harmonic flips). */
export function invertFrame(f: Frame): Frame {
  const out = cloneFrame(f);
  for (let k = 0; k <= FRAME_HARMONICS; k++) {
    out.sin[k] = -(f.sin[k] as number);
    out.cos[k] = -(f.cos[k] as number);
  }
  return out;
}

/** The shape played backwards (left to right mirrored). */
export function reverseFrame(f: Frame): Frame {
  const out = cloneFrame(f);
  for (let k = 1; k <= FRAME_HARMONICS; k++) out.sin[k] = -(f.sin[k] as number);
  return out;
}

/** A blend of two frames: `t` 0 = a, 1 = b. */
export function morphFrames(a: Frame, b: Frame, t: number): Frame {
  const out = newFrame();
  const u = clamp(t, 0, 1);
  for (let k = 0; k <= FRAME_HARMONICS; k++) {
    out.sin[k] = (a.sin[k] as number) * (1 - u) + (b.sin[k] as number) * u;
    out.cos[k] = (a.cos[k] as number) * (1 - u) + (b.cos[k] as number) * u;
  }
  return out;
}

/** `count` frames evenly between a and b (not including either). */
export function framesBetween(a: Frame, b: Frame, count: number): Frame[] {
  const out: Frame[] = [];
  for (let i = 1; i <= count; i++) out.push(morphFrames(a, b, i / (count + 1)));
  return out;
}

/** The table's shape at `position` (0–1): the key frames blended the way the oscillator blends them. */
export function frameAt(frames: readonly Frame[], position: number): Frame {
  if (frames.length === 0) return sineFrame();
  if (frames.length === 1) return frames[0] as Frame;
  const x = clamp(position, 0, 1) * (frames.length - 1);
  const i = Math.min(frames.length - 2, Math.floor(x));
  return morphFrames(frames[i] as Frame, frames[i + 1] as Frame, x - i);
}

/** A pure sine (what an empty table plays). */
export function sineFrame(): Frame {
  const f = newFrame();
  f.sin[1] = 1;
  return f;
}
