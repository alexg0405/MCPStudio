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

/** Flushes denormals and NaN to zero: use on feedback-path state. */
export function flush(x: number): number {
  return Math.abs(x) > 1e-20 ? x : 0;
}
