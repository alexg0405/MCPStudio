/**
 * An audio clip's gain envelope: its clip gain times an equal-power fade-in and fade-out. Fades are
 * in seconds of song time from the clip's ends. When the two fades overlap (a short clip) the curves
 * multiply, so the envelope stays smooth instead of jumping.
 *
 * The engine plays the envelope as linear ramps between `envelopeBreakpoints` (16 per fade, within
 * 0.2 % of the curve); the playlist draws the waveform with `clipEnvelopeAt`.
 */
import type { AudioClip } from '../model/types';

/** The three level settings of an audio clip that make its envelope: gain and the two fades. */
export type ClipLevels = Pick<AudioClip, 'gain' | 'fadeIn' | 'fadeOut'>;

/** Linear ramps per fade when the engine plays it. */
export const FADE_SEGMENTS = 16;
/** Peak a normalized clip reaches. */
export const NORMALIZE_DB = -0.3;
/** The highest linear gain a clip may have (4 is about +12 dB). */
export const MAX_CLIP_GAIN = 4;

/** Equal-power fade-in shape over x in 0..1 (−3 dB at the middle). */
export function fadeShape(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.sin((x * Math.PI) / 2);
}

/** The clip's gain as a linear factor: 1 when unset or not a number, otherwise kept between 0 and `MAX_CLIP_GAIN`. */
export const clipGain = (c: ClipLevels): number =>
  c.gain !== undefined && Number.isFinite(c.gain) ? Math.max(0, Math.min(MAX_CLIP_GAIN, c.gain)) : 1;

const fade = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);

/** The envelope at `x` seconds into a clip lasting `duration` seconds (0 outside the clip). */
export function clipEnvelopeAt(c: ClipLevels, x: number, duration: number): number {
  if (x < 0 || x > duration) return 0;
  const g = clipGain(c);
  const fi = fade(c.fadeIn);
  const fo = fade(c.fadeOut);
  const a = fi > 0 ? fadeShape(x / fi) : 1;
  const b = fo > 0 ? fadeShape((duration - x) / fo) : 1;
  return g * a * b;
}

/**
 * Times (seconds into the clip, from `from` on, sorted, starting with `from`) where the envelope
 * bends, with its value there. Linear ramps between them follow the curve; it holds between fades.
 */
export function envelopeBreakpoints(c: ClipLevels, duration: number, from = 0): Array<[number, number]> {
  const fi = Math.min(fade(c.fadeIn), duration);
  const fo = Math.min(fade(c.fadeOut), duration);
  const xs = new Set<number>([Math.max(0, from)]);
  for (let k = 1; k <= FADE_SEGMENTS; k++) {
    if (fi > 0) xs.add((fi * k) / FADE_SEGMENTS);
    if (fo > 0) xs.add(duration - fo + (fo * (k - 1)) / FADE_SEGMENTS);
  }
  if (fo > 0) xs.add(duration);
  return [...xs]
    .filter((x) => x >= from && x <= duration)
    .sort((a, b) => a - b)
    .map((x) => [x, clipEnvelopeAt(c, x, duration)]);
}

/** Linear gain → dB (−Infinity for 0). */
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
/** Decibels → linear gain (0 dB is 1, -6 dB is about 0.5); the reverse of `gainToDb`. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** "+3.5 dB", "−inf dB". */
export function formatDb(g: number): string {
  const db = gainToDb(g);
  if (!Number.isFinite(db)) return '−inf dB';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} dB`;
}

/** "12 ms", "1.25 s". */
export function formatSeconds(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  return `${(Math.round(s * 100) / 100).toFixed(2)} s`;
}

/** The clip gain that brings a peak to −0.3 dBFS (clamped to the clip gain range). */
export function normalizeGain(peak: number, targetDb = NORMALIZE_DB): number {
  if (!(peak > 0)) return 1;
  return Math.max(0, Math.min(MAX_CLIP_GAIN, dbToGain(targetDb) / peak));
}
