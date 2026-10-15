/**
 * Where bars start: for each beat, how much it looks like beat 1 of a bar (the kick lands there,
 * the snare doesn't, chords change there and sections start there), folded by beat position for 4
 * (and 3) beats per bar. The phase with the most "downbeat-ness" wins; 3/4 only when it is clearly
 * a better fit than 4/4.
 */
import { chromaBetween, type Chromagram } from './chroma';
import type { OnsetFeatures } from './onset';

export interface BarPhase {
  /** Index into the beats of the first downbeat. */
  first: number;
  beatsPerBar: 3 | 4;
  /** 0–1: how clearly one beat position stands out. */
  confidence: number;
}

function peakNear(x: ArrayLike<number>, i: number, r = 2): number {
  const c = Math.round(i);
  let m = 0;
  for (let j = Math.max(0, c - r); j <= Math.min(x.length - 1, c + r); j++) if (x[j]! > m) m = x[j]!;
  return m;
}

function zscore(v: number[]): number[] {
  const n = Math.max(1, v.length);
  const m = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return v.map((x) => (sd > 1e-9 ? (x - m) / sd : 0));
}

/** Mean power (dB) of the frames in [t0, t1). */
function levelDb(f: OnsetFeatures, t0: number, t1: number): number {
  const a = Math.max(0, Math.round(t0 * f.frameRate));
  const b = Math.min(f.power.length, Math.max(a + 1, Math.round(t1 * f.frameRate)));
  let s = 0;
  for (let i = a; i < b; i++) s += f.power[i]!;
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-10);
}

/** How much each beat looks like a downbeat (z-scored cues, summed). */
export function downbeatEvidence(f: OnsetFeatures, c: Chromagram, beats: readonly number[]): number[] {
  const n = beats.length;
  const fr = f.frameRate;
  const period = n > 1 ? (beats[n - 1]! - beats[0]!) / (n - 1) : 0.5;
  const at = (i: number) => beats[i] ?? beats[0]! + i * period;
  const kick: number[] = [];
  const snare: number[] = [];
  const harmony: number[] = [];
  const energy: number[] = [];
  for (let i = 0; i < n; i++) {
    const fi = beats[i]! * fr;
    kick.push(peakNear(f.low, fi));
    snare.push(peakNear(f.lowMid, fi) + 0.5 * peakNear(f.highMid, fi));
    // Chord change: the two beats before against the two beats from here.
    const before = chromaBetween(c, at(i - 2), at(i), 1);
    const after = chromaBetween(c, at(i), at(i + 2), 1);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < 12; k++) {
      dot += before[k]! * after[k]!;
      na += before[k]! ** 2;
      nb += after[k]! ** 2;
    }
    harmony.push(na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0);
    // Section change: the level of the next four beats against the last four.
    energy.push(Math.abs(levelDb(f, at(i), at(i + 4)) - levelDb(f, at(i - 4), at(i))));
  }
  const zk = zscore(kick);
  const zs = zscore(snare);
  const zh = zscore(harmony);
  const ze = zscore(energy);
  return beats.map((_, i) => zk[i]! - 0.6 * zs[i]! + zh[i]! + 0.5 * ze[i]!);
}

export function barPhase(f: OnsetFeatures, c: Chromagram, beats: readonly number[]): BarPhase {
  const ev = downbeatEvidence(f, c, beats);
  const fold = (m: number) => {
    const sums = new Array<number>(m).fill(0);
    const counts = new Array<number>(m).fill(0);
    ev.forEach((v, i) => {
      sums[i % m] = sums[i % m]! + v;
      counts[i % m] = counts[i % m]! + 1;
    });
    const means = sums.map((s, p) => s / Math.max(1, counts[p]!));
    let best = 0;
    for (let p = 1; p < m; p++) if (means[p]! > means[best]!) best = p;
    const avg = means.reduce((a, b) => a + b, 0) / m;
    const others = means.filter((_, p) => p !== best);
    const runnerUp = Math.max(...others);
    return { phase: best, contrast: means[best]! - avg, margin: means[best]! - runnerUp };
  };
  const four = fold(4);
  const three = fold(3);
  const waltz = three.contrast > 0.3 && three.contrast > 1.4 * four.contrast;
  const pick = waltz ? three : four;
  return {
    first: pick.phase,
    beatsPerBar: waltz ? 3 : 4,
    confidence: Math.round(Math.max(0, Math.min(1, pick.margin / 0.8)) * 100) / 100,
  };
}
