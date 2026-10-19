/**
 * WaveShaper transfer curves for the Distortion. The node maps its input range [-1, 1] onto the
 * curve, so the curve covers ±RANGE in signal units and the drive is a gain before the shaper
 * (smoothed by the host, unlike rewriting the curve). An odd point count puts 0 exactly on the
 * centre sample, so silence stays silent and no DC appears.
 */

export type CurveKind = 'soft' | 'hard' | 'fold';

/** Signal level at either end of the curve (drive × input beyond this sticks to the end value). */
export const RANGE = 128;
/** 2^16 + 1 points: 1/256 signal units per step, so the hard clip's corners land on samples. */
export const POINTS = 65537;

/** Level the drive compensation keeps roughly constant (≈ -12 dBFS). */
const REFERENCE = 0.25;

/** The transfer function of a curve at signal level `s`: soft is tanh, hard clips at ±1, fold is a sine. */
export function shape(kind: CurveKind, s: number): number {
  switch (kind) {
    case 'soft':
      return Math.tanh(s);
    case 'hard':
      if (s > 1) return 1;
      if (s < -1) return -1;
      return s;
    case 'fold':
      // Sine wavefolder: rises to 1 at s = 1, then folds back down (and over) as s grows.
      return Math.sin((Math.PI / 2) * s);
  }
}

const cache = new Map<CurveKind, Float32Array<ArrayBuffer>>();

/** The sampled curve (cached; WaveShaperNode copies it, so sharing is safe). */
export function curve(kind: CurveKind): Float32Array<ArrayBuffer> {
  let c = cache.get(kind);
  if (!c) {
    c = new Float32Array(POINTS);
    const mid = (POINTS - 1) / 2;
    for (let i = 0; i < POINTS; i++) c[i] = shape(kind, ((i - mid) / mid) * RANGE);
    cache.set(kind, c);
  }
  return c;
}

/**
 * Output gain that keeps a signal around REFERENCE at about the same level whatever the drive:
 * below saturation it undoes the drive, above it the shaper's output (≈ ±1) is scaled to REFERENCE.
 */
export function driveCompensation(driveGain: number): number {
  return REFERENCE / Math.min(1, Math.max(1e-6, driveGain) * REFERENCE);
}
