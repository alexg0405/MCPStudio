// Small math helpers shared by main-thread plugins and audio-thread kernels (no DOM, no allocation).

/** MIDI note number → frequency in Hz (A4 = 69 = 440 Hz). */
export function mtof(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** Frequency in Hz → fractional MIDI note number. */
export function ftom(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/** Decibels → linear gain. Anything at or below -150 dB is treated as silence. */
export function dbToGain(db: number): number {
  return db <= -150 ? 0 : Math.pow(10, db / 20);
}

/** Linear gain → decibels (-Infinity for 0). */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 2^−8 … 2^7, for `pow2`. */
const POW2_INT = [1 / 256, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128] as const;
const LN2 = Math.LN2;

/**
 * 2^u, for pitch and frequency ratios (u = semitones / 12, or cents / 1200). Inside −8 ≤ u < 8 it is
 * 2^⌊u⌋ times e^x for the fraction x = (u − ⌊u⌋)·ln 2, by a degree-9 Taylor series (relative error
 * below 4e-9): a few multiplies, where Math.pow is a call. Outside that range it is Math.pow.
 */
export function pow2(u: number): number {
  if (!(u >= -8 && u < 8)) return Math.pow(2, u);
  const n = Math.floor(u);
  const x = (u - n) * LN2;
  const p =
    1 +
    x *
      (1 +
        x *
          (1 / 2 +
            x *
              (1 / 6 +
                x * (1 / 24 + x * (1 / 120 + x * (1 / 720 + x * (1 / 5040 + x * (1 / 40320 + x * (1 / 362880)))))))));
  return (POW2_INT[n + 8] as number) * p;
}

/** Flushes denormals and NaN to zero: use on feedback-path state. */
export function flush(x: number): number {
  return Math.abs(x) > 1e-20 ? x : 0;
}
