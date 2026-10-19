/**
 * "Similar sounds": a small fingerprint per file (`SampleAnalysis.vec`) and the distance between two. The numbers are
 * all in 0..1 so that no one of them swamps the rest; the weights say how much each matters to the ear. Only files of the
 * same kind (one-shot with one-shot, loop with loop) are compared.
 */
import type { SoundFeatures } from './features';
import type { SampleKind } from './types';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** What each fingerprint number is, in order (weights for the distance). */
export const FINGERPRINT = [
  { name: 'brightness', weight: 2.2 },
  { name: 'sub', weight: 1.4 },
  { name: 'low', weight: 1.4 },
  { name: 'low-mid', weight: 1 },
  { name: 'mid', weight: 1 },
  { name: 'high', weight: 1.2 },
  { name: 'air', weight: 1.2 },
  { name: 'decay', weight: 2 },
  { name: 'pitched', weight: 1 },
  { name: 'attack', weight: 0.8 },
  { name: 'noisiness', weight: 0.8 },
  { name: 'pitch', weight: 1.3 },
  { name: 'stutter', weight: 0.5 },
] as const;

/** The fingerprint of a sound: its measurements scaled to 0..1, in the order of `FINGERPRINT`. */
export function fingerprint(f: SoundFeatures, _kind: SampleKind): number[] {
  const pitched = clamp01((f.voiced - 0.3) / 0.5);
  // Flatness says something only where there is energy above the bass.
  const noise = 1 - ((f.bands[0] as number) + (f.bands[1] as number)) > 0.25 ? clamp01(f.flatness) : 0;
  const pitch = f.f0 > 0 ? clamp01(Math.log2(Math.max(30, f.f0) / 30) / 6) * pitched : 0;
  return [
    clamp01(Math.log2(Math.max(50, f.centroid) / 50) / 8),
    ...f.bands.map((b) => b),
    clamp01(Math.log2(1 + Math.min(4, f.len40) * 20) / 6.4),
    pitched,
    clamp01(f.attackSec * 10),
    noise,
    pitch,
    clamp01((f.bursts - 1) / 3),
  ].map(round2);
}

/** Weighted Euclidean distance between two fingerprints (0 = the same sound). */
export function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < FINGERPRINT.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += (FINGERPRINT[i] as { weight: number }).weight * d * d;
  }
  return Math.sqrt(sum);
}
