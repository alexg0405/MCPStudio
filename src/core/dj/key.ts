/**
 * The key of a song from its chromagram: the song's average pitch-class profile (treble plus bass,
 * frames weighted by how tonal they are) correlated with major and minor key profiles in all 12
 * transpositions. Camelot wheel numbers for harmonic mixing.
 */
import type { Camelot, TrackKey } from './types';
import type { Chromagram } from './chroma';

/**
 * Key profiles: the mean of Krumhansl–Kessler's probe-tone ratings and Temperley's corpus profile
 * (each scaled to sum 1). Index 0 is the tonic.
 */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const T_MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const T_MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];
const unit = (v: number[]) => {
  const s = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / s);
};
const blend = (a: number[], b: number[]) => {
  const ua = unit(a);
  const ub = unit(b);
  return ua.map((x, i) => (x + ub[i]!) / 2);
};
/** The pitch-class profile of a major key that songs are compared with. */
export const MAJOR_PROFILE = blend(KK_MAJOR, T_MAJOR);
/** The pitch-class profile of a minor key that songs are compared with. */
export const MINOR_PROFILE = blend(KK_MINOR, T_MINOR);

/** The names of the 12 pitch classes, from C. */
export const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

/** Camelot position of a key: 8B = C major, 8A = A minor; one step round the wheel is a fifth. */
export function camelotOf(root: number, mode: 'major' | 'minor'): Camelot {
  const major = mode === 'major' ? root : root + 3; // a minor key sits with its relative major
  const fifths = (((major * 7) % 12) + 12) % 12; // C = 0, G = 1, D = 2 …
  const n = ((fifths + 7) % 12) + 1;
  return `${n}${mode === 'major' ? 'B' : 'A'}` as Camelot;
}

/** "A minor", "E♭ major". */
export function keyName(k: Pick<TrackKey, 'root' | 'mode'>): string {
  return `${PITCH_NAMES[((k.root % 12) + 12) % 12]} ${k.mode}`;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, shift: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= 12;
  mb /= 12;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + shift) % 12]! - ma;
    const y = b[i]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** How well each of the 24 keys fits a song, and the pitch-class profile they were scored from. */
export interface KeyScores {
  /** Correlation of each key: index root (major) and 12 + root (minor). */
  scores: number[];
  profile: Float64Array;
}

/** Stretches of a song (seconds) that count double: phrase starts, where songs sit on their tonic. */
export type KeyEmphasis = readonly (readonly [number, number])[];

/**
 * The song's pitch-class profile (sums to 1): frames weighted by the square root of their tonal
 * energy; treble and bass profiles mixed, the treble counting less when it is nearly flat (hats and
 * noise, no chords), and frames inside `emphasis` counting double.
 */
export function songProfile(c: Chromagram, emphasis: KeyEmphasis = [], bassWeight = 0.6): Float64Array {
  const treble = new Float64Array(12);
  const bass = new Float64Array(12);
  const weight = new Float64Array(c.frames).fill(1);
  for (const [t0, t1] of emphasis)
    for (let f = Math.max(0, Math.round(t0 * c.frameRate)); f < Math.min(c.frames, Math.round(t1 * c.frameRate)); f++) weight[f] = 2;
  for (let f = 0; f < c.frames; f++) {
    const e = c.energy[f]!;
    if (!(e > 0)) continue;
    // Each frame counts by sqrt(energy): loud frames lead, quiet ones still count.
    const w = weight[f]! / Math.sqrt(e);
    for (let k = 0; k < 12; k++) {
      treble[k] = treble[k]! + w * c.treble[f * 12 + k]!;
      bass[k] = bass[k]! + w * c.bass[f * 12 + k]!;
    }
  }
  const st = treble.reduce((x, y) => x + y, 0);
  const sb = bass.reduce((x, y) => x + y, 0);
  const peak = st > 0 ? (12 * Math.max(...treble)) / st : 0;
  const tw = sb > 0 ? Math.max(0.15, Math.min(1, (peak - 1.2) / 0.8)) : 1;
  const out = new Float64Array(12);
  for (let k = 0; k < 12; k++) out[k] = (st > 0 ? (tw * treble[k]!) / st : 0) + (sb > 0 ? (bassWeight * bass[k]!) / sb : 0);
  const s = out.reduce((x, y) => x + y, 0);
  if (s > 0) for (let k = 0; k < 12; k++) out[k] = out[k]! / s;
  return out;
}

/** How well each of the 24 keys fits a pitch-class profile (indexes as in `KeyScores`). */
export function keyScores(profile: Float64Array): number[] {
  const scores: number[] = [];
  for (let r = 0; r < 12; r++) scores.push(pearson(profile, MAJOR_PROFILE, r));
  for (let r = 0; r < 12; r++) scores.push(pearson(profile, MINOR_PROFILE, r));
  return scores;
}

/**
 * The key, or null when the audio has no clear pitch content (drums only, noise). Without a third
 * (an 808 on the root, a fifth and a flat seventh), the key is called minor: what most bass-led
 * hip-hop, trap and dance music is written in.
 */
export function estimateKey(c: Chromagram, emphasis: KeyEmphasis = []): TrackKey | null {
  const total = c.energy.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const profile = songProfile(c, emphasis);
  const scores = keyScores(profile);
  let best = 0;
  for (let i = 1; i < 24; i++) if (scores[i]! > scores[best]!) best = i;
  const r1 = scores[best]!;
  let r2 = -1;
  for (let i = 0; i < 24; i++) if (i !== best && scores[i]! > r2) r2 = scores[i]!;
  // How peaked the profile is: flat (noise, drums) profiles say nothing.
  let max = 0;
  for (let k = 0; k < 12; k++) max = Math.max(max, profile[k]!);
  if (r1 < 0.4 || max < 1.4 / 12) return null;
  const root = best % 12;
  const tonic = profile[root]!;
  const thirds = Math.max(profile[(root + 3) % 12]!, profile[(root + 4) % 12]!);
  const mode = best >= 12 || thirds < 0.1 * tonic ? 'minor' : 'major';
  const fit = Math.max(0, Math.min(1, (r1 - 0.45) / 0.4));
  const margin = Math.max(0, Math.min(1, (r1 - r2) / 0.1));
  return {
    root,
    mode,
    camelot: camelotOf(root, mode),
    confidence: Math.round(fit * (0.4 + 0.6 * margin) * 100) / 100,
  };
}
