/**
 * A song's shape for DJ mixing, bar by bar: an energy curve (loudness, how busy, how much low end),
 * sections where the energy and harmony change (snapped to 4/8-bar phrases), what kind each is
 * (intro, build, drop, break, verse, outro, body), and where to mix in and out.
 */
import type { Section } from './types';
import { chromaBetween, type Chromagram } from './chroma';
import type { OnsetFeatures } from './onset';

/** A song's shape: the energy per bar, its sections, and where to mix in and out (seconds). */
export interface Structure {
  /** 0–1 per bar. */
  energy: number[];
  sections: Section[];
  mixIn: number;
  mixOut: number;
  /** Bar index the 8-bar phrases start from (0–7). */
  phraseOrigin: number;
}

/** Keeps a value within 0…1. */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The value at quantile `q` (0…1) of a list (0 for none). */
function percentile(v: readonly number[], q: number): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
}

/** What one bar sounds like: its loudness (dB), how many onsets it has, and the share of its power in the low end. */
interface BarStats {
  loud: number;
  density: number;
  lowShare: number;
}

/** The stats of the bar between two times (seconds). */
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

/** A section is a "body" (full) when its energy reaches this share of the loudest section's, and a "break" below the lower one; under `INTRO_LEVEL` the start and end count as intro and outro. */
const BODY_LEVEL = 0.8;
const BREAK_LEVEL = 0.45;
const INTRO_LEVEL = 0.75;

/** Phrases are 8 bars long; a section change is likely on the phrase line, or half way (4 bars) with a stronger change. */
const PHRASE_BARS = 8;
const HALF_PHRASE_BARS = 4;
const PHRASE_LINE_NOVELTY_SHARE = 0.3;
const HALF_PHRASE_NOVELTY_SHARE = 0.5;
/** Two section changes are at least this many bars apart. */
const MIN_SECTION_GAP_BARS = 4;
/** A grid other than the one from the first downbeat must collect this much more novelty to be chosen. */
const PHRASE_ORIGIN_ADVANTAGE = 1.2;
/** Novelty looks at up to this many bars on each side of a bar line. */
const NOVELTY_WINDOW_BARS = 4;

/** The music ends after the last bar that is not within this many dB of silence (below the loud bars). */
const SILENCE_BELOW_TOP_DB = 40;

/** A drop's second half must be this much (0–1 energy) louder than its first for the section before it to be a build. */
const BUILD_RISE = 0.08;

/** Mixing in: a song whose intro gives at least this many bars is mixed in from its start. Mixing out looks for a section start this many bars before the outro, up to `MAX_MIX_OUT_BARS`. */
const MIN_MIX_BARS = 8;
const MAX_MIX_OUT_BARS = 32;
/** With no section to use, the mix-out is this many bars before the outro (or the end). */
const FALLBACK_MIX_OUT_BARS = 16;

/** Weights of a bar's features in the novelty measure: energy, density, low end, and each chroma value. */
const ENERGY_WEIGHT = 2;
const LOW_END_WEIGHT = 2;
const CHROMA_WEIGHT = 1.5;

/** The features of each bar that novelty compares: energy, how busy, how much low end, and the harmony (chroma). */
function barFeatures(c: Chromagram, bounds: readonly number[], energy: number[], stats: BarStats[]): number[][] {
  const densityTop = Math.max(
    1e-9,
    percentile(
      stats.map((s) => s.density),
      0.95,
    ),
  );
  return stats.map((s, i) => {
    const chroma = chromaBetween(c, bounds[i]!, bounds[i + 1]!, 1);
    return [ENERGY_WEIGHT * energy[i]!, s.density / densityTop, LOW_END_WEIGHT * clamp01(s.lowShare * 2), ...Array.from(chroma, (x) => CHROMA_WEIGHT * x)];
  });
}

/** How much the music changes at each bar line (index b = the line before bar b), over a window of up to 4 bars each side. */
function barNovelty(features: number[][], barCount: number, end: number): number[] {
  const novelty = new Array<number>(barCount + 1).fill(0);
  for (let b = 1; b < end; b++) {
    const window = Math.min(NOVELTY_WINDOW_BARS, b, end - b);
    if (window < 1) continue;
    let squared = 0;
    for (let k = 0; k < features[0]!.length; k++) {
      let before = 0;
      let after = 0;
      for (let j = 1; j <= window; j++) {
        before += features[b - j]![k]!;
        after += features[b + j - 1]![k]!;
      }
      squared += ((after - before) / window) ** 2;
    }
    novelty[b] = Math.sqrt(squared);
  }
  return novelty;
}

/** The bar's position within the 8-bar phrases that start at bar `origin` (0–7). */
const phrasePosition = (bar: number, origin: number): number => (((bar - origin) % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS;

/** Phrases: the 8-bar grid that collects the most novelty (the first downbeat unless clearly not). */
function phraseOriginOf(novelty: number[], end: number): number {
  const score = (origin: number) => {
    let total = 0;
    for (let b = 1; b < end; b++) {
      const position = phrasePosition(b, origin);
      if (position === 0) total += novelty[b]!;
      else if (position === HALF_PHRASE_BARS) total += 0.5 * novelty[b]!;
    }
    return total;
  };
  let origin = 0;
  for (let o = 1; o < PHRASE_BARS; o++) if (score(o) > score(origin)) origin = o;
  return score(origin) > PHRASE_ORIGIN_ADVANTAGE * score(0) ? origin : 0;
}

/** The bar lines where a new section starts: peaks of novelty on the phrase lines, strongest first, none closer than 4 bars to another. */
function sectionCuts(novelty: number[], end: number, origin: number): number[] {
  const maxNovelty = Math.max(1e-9, ...novelty);
  const candidates: number[] = [];
  for (let b = 2; b < end - 1; b++) {
    if (novelty[b]! < novelty[b - 1]! || novelty[b]! < novelty[b + 1]!) continue;
    const position = phrasePosition(b, origin);
    if (position === 0 && novelty[b]! >= PHRASE_LINE_NOVELTY_SHARE * maxNovelty) candidates.push(b);
    else if (position === HALF_PHRASE_BARS && novelty[b]! >= HALF_PHRASE_NOVELTY_SHARE * maxNovelty) candidates.push(b);
  }
  candidates.sort((a, b) => novelty[b]! - novelty[a]!);
  const cuts: number[] = [];
  for (const b of candidates) if (cuts.every((x) => Math.abs(x - b) >= MIN_SECTION_GAP_BARS)) cuts.push(b);
  return cuts.sort((a, b) => a - b);
}

/** The average of `values` from index `from` up to `to` (0 for none). */
const averageOf = (values: number[], from: number, to: number): number => values.slice(from, to).reduce((x, y) => x + y, 0) / Math.max(1, to - from);

/** What the sections are like: each one's energy relative to the loudest, their kinds, and where the intro and outro end/start (as section indices). */
interface SectionKinds {
  relative: number[];
  kinds: Section['kind'][];
  introEnd: number;
  outroStart: number;
}

/** Decides the kind of each section (intro, build, drop, break, verse, outro, body) from the energy of its bars. */
function classifySections(edges: number[], energy: number[]): SectionKinds {
  const sectionEnergy = edges.slice(0, -1).map((start, i) => averageOf(energy, start, edges[i + 1]!));
  const loudest = Math.max(1e-9, ...sectionEnergy);
  const relative = sectionEnergy.map((e) => e / loudest);
  const count = relative.length;
  const kinds: Section['kind'][] = relative.map((r) => (r >= BODY_LEVEL ? 'body' : r < BREAK_LEVEL ? 'break' : 'verse'));
  let introEnd = 0; // in sections
  while (introEnd < count - 1 && relative[introEnd]! < INTRO_LEVEL) kinds[introEnd++] = 'intro';
  let outroStart = count;
  while (outroStart - 1 > introEnd && relative[outroStart - 1]! < INTRO_LEVEL) kinds[--outroStart] = 'outro';
  for (let i = introEnd; i < outroStart; i++) {
    if (relative[i]! >= BODY_LEVEL && i > 0 && relative[i - 1]! < INTRO_LEVEL) kinds[i] = 'drop';
  }
  // The section before a drop is a build when it gets louder towards it.
  for (let i = Math.max(1, introEnd); i < outroStart; i++) {
    if (kinds[i] !== 'drop' || kinds[i - 1] === 'intro') continue;
    const start = edges[i - 1]!;
    const stop = edges[i]!;
    const middle = Math.floor((start + stop) / 2);
    if (averageOf(energy, middle, stop) - averageOf(energy, start, middle) >= BUILD_RISE) kinds[i - 1] = 'build';
  }
  return { relative, kinds, introEnd, outroStart };
}

/** Mix in (a bar index): the whole song when its intro gives at least 8 bars to mix over, else its first full phrase. */
function mixInBar(edges: number[], kinds: SectionKinds): number {
  const sectionCount = kinds.relative.length;
  const introBars = edges[kinds.introEnd]!;
  let firstFull = 0;
  while (firstFull < sectionCount && kinds.relative[firstFull]! < INTRO_LEVEL) firstFull++;
  return introBars >= MIN_MIX_BARS || firstFull >= sectionCount ? 0 : edges[firstFull]!;
}

/** Mix out (a bar index): the outro when it is at least 8 bars, else the last phrases before it (or the end). */
function mixOutBar(edges: number[], kinds: SectionKinds, end: number, mixIn: number, origin: number): number {
  const sectionCount = kinds.relative.length;
  const outroBarStart = edges[kinds.outroStart]!;
  const outroBars = end - outroBarStart;
  if (kinds.outroStart < sectionCount && outroBars >= MIN_MIX_BARS) return outroBarStart;
  const reference = kinds.outroStart < sectionCount ? outroBarStart : end;
  // A section start 8–32 bars before it, latest first; else the phrase 16 bars before it.
  const fromSections = edges.filter((b) => b > mixIn && reference - b >= MIN_MIX_BARS && reference - b <= MAX_MIX_OUT_BARS);
  if (fromSections.length) return fromSections[fromSections.length - 1]!;
  let bar = reference - FALLBACK_MIX_OUT_BARS;
  bar -= phrasePosition(bar, origin);
  return Math.max(bar, mixIn + MIN_MIX_BARS <= reference - MIN_MIX_BARS ? mixIn + MIN_MIX_BARS : 0);
}

/**
 * Sections and mix points for bars with boundaries `bounds` (downbeats, n + 1 times for n bars).
 * The phrases are 8 bars for songs on a beat grid.
 */
export function analyzeStructure(f: OnsetFeatures, c: Chromagram, bounds: readonly number[], durationSec: number): Structure {
  const barCount = bounds.length - 1;
  if (barCount <= 0) return { energy: [], sections: [], mixIn: 0, mixOut: Math.max(0, durationSec), phraseOrigin: 0 };
  const { energy, stats } = barEnergy(f, bounds);
  const top = percentile(
    stats.map((s) => s.loud),
    0.95,
  );
  // The music ends after the last bar that isn't (nearly) silent.
  let end = barCount;
  while (end > 1 && stats[end - 1]!.loud < top - SILENCE_BELOW_TOP_DB) end--;
  const novelty = barNovelty(barFeatures(c, bounds, energy, stats), barCount, end);
  const origin = phraseOriginOf(novelty, end);
  const edges = [0, ...sectionCuts(novelty, end, origin), end];

  const kinds = classifySections(edges, energy);
  const lastSection = kinds.relative.length - 1;
  const sections: Section[] = kinds.relative.map((r, i) => ({
    start: bounds[edges[i]!]!,
    end: i === lastSection ? durationSec : bounds[edges[i + 1]!]!,
    energy: Math.round(r * 1000) / 1000,
    kind: kinds.kinds[i]!,
  }));

  const inBar = mixInBar(edges, kinds);
  const outBar = Math.max(0, Math.min(barCount - 1, mixOutBar(edges, kinds, end, inBar, origin)));
  return {
    energy,
    sections,
    mixIn: bounds[inBar]!,
    mixOut: bounds[Math.max(outBar, Math.min(barCount - 1, inBar + 1))]!,
    phraseOrigin: origin,
  };
}
