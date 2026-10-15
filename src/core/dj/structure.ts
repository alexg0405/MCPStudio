/**
 * A song's shape for DJ mixing, bar by bar: an energy curve (loudness, how busy, how much low end),
 * sections where the energy and harmony change (snapped to 4/8-bar phrases), what kind each is
 * (intro, build, drop, break, verse, outro, body), and where to mix in and out.
 */
import type { Section } from './types';
import { chromaBetween, type Chromagram } from './chroma';
import type { OnsetFeatures } from './onset';

export interface Structure {
  /** 0–1 per bar. */
  energy: number[];
  sections: Section[];
  mixIn: number;
  mixOut: number;
  /** Bar index the 8-bar phrases start from (0–7). */
  phraseOrigin: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function percentile(v: readonly number[], q: number): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
}

interface BarStats {
  loud: number;
  density: number;
  lowShare: number;
}

function barStats(f: OnsetFeatures, t0: number, t1: number): BarStats {
  const a = Math.max(0, Math.round(t0 * f.frameRate));
  const b = Math.min(f.power.length, Math.max(a + 1, Math.round(t1 * f.frameRate)));
  let p = 0;
  let pl = 0;
  let o = 0;
  for (let i = a; i < b; i++) {
    p += f.power[i]!;
    pl += f.lowPower[i]!;
    o += f.onset[i]!;
  }
  const n = Math.max(1, b - a);
  return { loud: 10 * Math.log10(p / n + 1e-10), density: o / n, lowShare: p > 0 ? pl / p : 0 };
}

/** Energy 0–1 for bars with the given boundaries (n + 1 times for n bars). */
export function barEnergy(f: OnsetFeatures, bounds: readonly number[]): { energy: number[]; stats: BarStats[] } {
  const stats: BarStats[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) stats.push(barStats(f, bounds[i]!, bounds[i + 1]!));
  const top = percentile(
    stats.map((s) => s.loud),
    0.95,
  );
  const dTop = percentile(
    stats.map((s) => s.density),
    0.95,
  );
  const sTop = percentile(
    stats.map((s) => s.lowShare),
    0.95,
  );
  const raw = stats.map((s) => {
    const l = clamp01((s.loud - (top - 24)) / 24);
    const d = dTop > 0 ? clamp01(s.density / dTop) : 0;
    const lo = sTop > 0 ? clamp01(s.lowShare / sTop) : 0;
    // A silent bar has no density or low end worth counting.
    return l > 0 ? 0.55 * l + 0.25 * d + 0.2 * lo : 0;
  });
  const max = Math.max(1e-9, ...raw);
  // Squared: a drums-only intro at −3 dB reads as clearly less than the full mix.
  return { energy: raw.map((e) => Math.round((e / max) ** 2 * 1000) / 1000), stats };
}

/** Mixing in and out: see `analyzeStructure`. */
const LOW = 0.75;
const HIGH = 0.8;

/**
 * Sections and mix points for bars with boundaries `bounds` (downbeats, n + 1 times for n bars).
 * `phraseBars` is 8 for songs on a beat grid.
 */
export function analyzeStructure(f: OnsetFeatures, c: Chromagram, bounds: readonly number[], durationSec: number): Structure {
  const n = bounds.length - 1;
  if (n <= 0) return { energy: [], sections: [], mixIn: 0, mixOut: Math.max(0, durationSec), phraseOrigin: 0 };
  const { energy, stats } = barEnergy(f, bounds);
  const top = percentile(
    stats.map((s) => s.loud),
    0.95,
  );
  // The music ends after the last bar that isn't (nearly) silent.
  let end = n;
  while (end > 1 && stats[end - 1]!.loud < top - 40) end--;
  // Bar features for novelty: energy, density, low end, harmony.
  const dTop = Math.max(1e-9, percentile(stats.map((s) => s.density), 0.95));
  const feats = stats.map((s, i) => {
    const ch = chromaBetween(c, bounds[i]!, bounds[i + 1]!, 1);
    return [2 * energy[i]!, s.density / dTop, 2 * clamp01(s.lowShare * 2), ...Array.from(ch, (x) => 1.5 * x)];
  });
  const novelty = new Array<number>(n + 1).fill(0);
  for (let b = 1; b < end; b++) {
    const w = Math.min(4, b, end - b);
    if (w < 1) continue;
    let d = 0;
    for (let k = 0; k < feats[0]!.length; k++) {
      let before = 0;
      let after = 0;
      for (let j = 1; j <= w; j++) {
        before += feats[b - j]![k]!;
        after += feats[b + j - 1]![k]!;
      }
      d += ((after - before) / w) ** 2;
    }
    novelty[b] = Math.sqrt(d);
  }
  // Phrases: the 8-bar grid that collects the most novelty (the first downbeat unless clearly not).
  const phraseScore = (o: number) => {
    let s = 0;
    for (let b = 1; b < end; b++) {
      const r = (((b - o) % 8) + 8) % 8;
      if (r === 0) s += novelty[b]!;
      else if (r === 4) s += 0.5 * novelty[b]!;
    }
    return s;
  };
  let origin = 0;
  for (let o = 1; o < 8; o++) if (phraseScore(o) > phraseScore(origin)) origin = o;
  if (!(phraseScore(origin) > 1.2 * phraseScore(0))) origin = 0;
  const maxNov = Math.max(1e-9, ...novelty);
  const cands: number[] = [];
  for (let b = 2; b < end - 1; b++) {
    if (novelty[b]! < novelty[b - 1]! || novelty[b]! < novelty[b + 1]!) continue;
    const r = (((b - origin) % 8) + 8) % 8;
    if (r === 0 && novelty[b]! >= 0.3 * maxNov) cands.push(b);
    else if (r === 4 && novelty[b]! >= 0.5 * maxNov) cands.push(b);
  }
  cands.sort((a, b) => novelty[b]! - novelty[a]!);
  const cuts: number[] = [];
  for (const b of cands) if (cuts.every((x) => Math.abs(x - b) >= 4)) cuts.push(b);
  cuts.sort((a, b) => a - b);
  const edges = [0, ...cuts, end];

  // Sections and their kinds.
  const secE = edges.slice(0, -1).map((a, i) => {
    const b = edges[i + 1]!;
    return energy.slice(a, b).reduce((x, y) => x + y, 0) / Math.max(1, b - a);
  });
  const eMax = Math.max(1e-9, ...secE);
  const rel = secE.map((e) => e / eMax);
  const m = rel.length;
  const kinds: Section['kind'][] = rel.map((r) => (r >= HIGH ? 'body' : r < 0.45 ? 'break' : 'verse'));
  let introEnd = 0; // sections
  while (introEnd < m - 1 && rel[introEnd]! < LOW) kinds[introEnd++] = 'intro';
  let outroStart = m;
  while (outroStart - 1 > introEnd && rel[outroStart - 1]! < LOW) kinds[--outroStart] = 'outro';
  for (let i = introEnd; i < outroStart; i++) {
    if (rel[i]! >= HIGH && i > 0 && rel[i - 1]! < LOW) kinds[i] = 'drop';
  }
  for (let i = Math.max(1, introEnd); i < outroStart; i++) {
    if (kinds[i] !== 'drop' || kinds[i - 1] === 'intro') continue;
    const a = edges[i - 1]!;
    const b = edges[i]!;
    const h = Math.floor((a + b) / 2);
    const first = energy.slice(a, h).reduce((x, y) => x + y, 0) / Math.max(1, h - a);
    const second = energy.slice(h, b).reduce((x, y) => x + y, 0) / Math.max(1, b - h);
    if (second - first >= 0.08) kinds[i - 1] = 'build';
  }
  const sections: Section[] = rel.map((r, i) => ({
    start: bounds[edges[i]!]!,
    end: i === m - 1 ? durationSec : bounds[edges[i + 1]!]!,
    energy: Math.round(r * 1000) / 1000,
    kind: kinds[i]!,
  }));

  // Mix in: the whole song when its intro gives at least 8 bars to mix over, else its first full phrase.
  const introBars = edges[introEnd]!;
  let firstFull = 0;
  while (firstFull < m && rel[firstFull]! < LOW) firstFull++;
  const inBar = introBars >= 8 || firstFull >= m ? 0 : edges[firstFull]!;
  // Mix out: the outro when it is at least 8 bars, else the last phrases before it (or the end).
  const outBarStart = edges[outroStart]!;
  const outroBars = end - outBarStart;
  let outBar: number;
  if (outroStart < m && outroBars >= 8) outBar = outBarStart;
  else {
    const ref = outroStart < m ? outBarStart : end;
    // A section start 8–32 bars before it, latest first; else the phrase 16 bars before it.
    const fromSections = edges.filter((b) => b > inBar && ref - b >= 8 && ref - b <= 32);
    if (fromSections.length) outBar = fromSections[fromSections.length - 1]!;
    else {
      let b = ref - 16;
      b -= (((b - origin) % 8) + 8) % 8;
      outBar = Math.max(b, inBar + 8 <= ref - 8 ? inBar + 8 : 0);
    }
  }
  outBar = Math.max(0, Math.min(n - 1, outBar));
  return {
    energy,
    sections,
    mixIn: bounds[inBar]!,
    mixOut: bounds[Math.max(outBar, Math.min(n - 1, inBar + 1))]!,
    phraseOrigin: origin,
  };
}
