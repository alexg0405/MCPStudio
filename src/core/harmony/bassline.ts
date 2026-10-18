/**
 * Basslines from a chord track: roots, root and fifth, a walking line, or an 808 that hits where the kick does. Times are
 * ticks from the start of the pattern (the caller maps the song's chord track onto the pattern). Pure, no DOM.
 */
import { chordPitchClasses, mod12, type ChordSymbol } from './chord';
import { scalePitchClasses, type KeyLike } from './scale';

export type BassStyle = 'roots' | 'root-fifth' | 'walking' | '808';
export const BASS_STYLES: readonly BassStyle[] = ['roots', 'root-fifth', 'walking', '808'];

export interface BassChord {
  tick: number;
  length: number;
  chord: ChordSymbol;
}

export interface BassNote {
  tick: number;
  length: number;
  key: number;
  velocity: number;
}

export interface BassOptions {
  style: BassStyle;
  /** Ticks per bar and per beat. */
  bar: number;
  beat: number;
  /** Total length to fill, in ticks (default: the end of the last chord). */
  end?: number;
  /** The lowest key the line uses (default 33 for a bass, 28 for an 808): it stays in about the octave above. */
  low?: number;
  /** 808 only: where the kick hits, in ticks from the start of one cycle (a pattern of `cycle` ticks); repeats to the end. */
  kicks?: readonly number[];
  cycle?: number;
  /** The song key, so the walking line's passing notes stay in it. */
  key?: KeyLike | null;
  /** Varies the walking line (the same seed gives the same line). */
  seed?: number;
  velocity?: number;
}

/** The lowest key at or above `low` with this pitch class. */
const keyAtOrAbove = (pc: number, low: number): number => low + mod12(pc - low);

/** The chord (and its index) sounding at a tick. */
function chordAt(chords: readonly BassChord[], tick: number): BassChord | null {
  let hit: BassChord | null = null;
  for (const c of chords) if (c.tick <= tick && tick < c.tick + c.length) hit = c;
  return hit;
}

const bassPc = (c: ChordSymbol) => (c.bass !== undefined ? mod12(c.bass) : mod12(c.root));

/** Default 808 pattern when the song has no kick to follow: 16th steps within a bar. */
export const DEFAULT_808_STEPS: readonly number[] = [0, 6, 10];

function rand(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A bassline for the chords. Notes never overlap each other and stop where the next chord starts. */
export function makeBassline(chordsIn: readonly BassChord[], opts: BassOptions): BassNote[] {
  const chords = [...chordsIn].filter((c) => c.length > 0).sort((a, b) => a.tick - b.tick);
  if (chords.length === 0) return [];
  const vel = opts.velocity ?? 0.85;
  const end = opts.end ?? Math.max(...chords.map((c) => c.tick + c.length));
  const low = opts.low ?? (opts.style === '808' ? 28 : 33);
  const out: BassNote[] = [];
  const push = (tick: number, length: number, key: number, velocity = vel) => {
    if (length < 1 || tick >= end) return;
    out.push({ tick: Math.round(tick), length: Math.max(1, Math.round(Math.min(length, end - tick))), key, velocity });
  };

  if (opts.style === 'roots') {
    for (const c of chords) {
      const key = keyAtOrAbove(bassPc(c.chord), low);
      // One note per bar line inside the chord so a long chord keeps breathing.
      for (let t = c.tick; t < c.tick + c.length; ) {
        const barEnd = (Math.floor(t / opts.bar) + 1) * opts.bar;
        const stop = Math.min(c.tick + c.length, barEnd);
        push(t, (stop - t) * 0.95, key, t === c.tick ? vel : vel * 0.9);
        t = stop;
      }
    }
    return out;
  }

  if (opts.style === 'root-fifth') {
    for (const c of chords) {
      const root = keyAtOrAbove(bassPc(c.chord), low);
      // The fifth goes up, or down when that keeps the line in range.
      const fifth = root + 7 > low + 14 ? root - 5 : root + 7;
      let i = 0;
      for (let t = c.tick; t < c.tick + c.length; t += opts.beat, i++) {
        const len = Math.min(opts.beat, c.tick + c.length - t);
        push(t, len * 0.9, i % 2 === 0 ? root : fifth, i === 0 ? vel : vel * 0.85);
      }
    }
    return out;
  }

  if (opts.style === 'walking') {
    const r = rand(opts.seed ?? 1);
    const scale = opts.key ? scalePitchClasses(opts.key) : null;
    let prev = -1;
    const nearest = (pc: number, around: number): number => {
      let best = keyAtOrAbove(pc, low);
      for (let k = best; k <= low + 19; k += 12) if (Math.abs(k - around) < Math.abs(best - around)) best = k;
      return best;
    };
    chords.forEach((c, ci) => {
      const next = chords[ci + 1]?.tick === c.tick + c.length ? (chords[ci + 1] as BassChord) : (chords[ci + 1] ?? chords[0] ?? c);
      const root = keyAtOrAbove(bassPc(c.chord), low);
      const tones = chordPitchClasses(c.chord).filter((pc) => pc !== bassPc(c.chord));
      const beats = Math.max(1, Math.round(c.length / opts.beat));
      for (let b = 0; b < beats; b++) {
        const t = c.tick + b * opts.beat;
        const len = Math.min(opts.beat, c.tick + c.length - t);
        let key: number;
        if (b === 0) key = root;
        else if (b === beats - 1 && beats > 1) {
          // Approach the next chord's root from a half step or (sometimes) a scale step, below or above.
          const target = nearest(bassPc(next.chord), prev < 0 ? root : prev);
          const near = [target - 1, target + 1];
          const step = scale ? [target - 2, target + 2].filter((k) => scale.includes(mod12(k))) : [];
          const pool = (step.length && r() < 0.35 ? step : near).filter((k) => k >= low && k <= low + 19);
          const from = prev < 0 ? root : prev;
          key = (pool.length ? pool : near).reduce((best, k) => (Math.abs(k - from) < Math.abs(best - from) ? k : best));
        } else {
          const pcs = tones.length ? tones : [bassPc(c.chord)];
          const pc = pcs[Math.floor(r() * pcs.length)] as number;
          key = nearest(pc, prev < 0 ? root + 4 : prev);
          if (key === prev) key = nearest(pcs[(pcs.indexOf(pc) + 1) % pcs.length] as number, prev);
        }
        push(t, len * 0.92, key, b === 0 ? vel : vel * 0.85);
        prev = key;
      }
    });
    return out;
  }

  // 808: the kick's hits, each playing the chord's bass note until the next hit (or the chord changes).
  const cycle = Math.max(1, Math.round(opts.cycle ?? opts.bar));
  const kicks =
    opts.kicks && opts.kicks.length ? [...opts.kicks] : DEFAULT_808_STEPS.map((s) => Math.round((s * opts.bar) / 16));
  const hits: number[] = [];
  for (let base = 0; base < end; base += cycle) for (const k of kicks) if (base + k < end && base + k >= 0) hits.push(base + k);
  // An 808 changes pitch with the chord, so each chord starts a note even where the kick does not.
  for (const c of chords) if (!hits.some((h) => Math.abs(h - c.tick) < opts.bar / 32)) hits.push(c.tick);
  hits.sort((a, b) => a - b);
  const uniq = hits.filter((h, i) => i === 0 || h - (hits[i - 1] as number) > 10);
  uniq.forEach((t, i) => {
    const c = chordAt(chords, t);
    if (!c) return;
    const nextHit = uniq[i + 1] ?? end;
    const stop = Math.min(nextHit, c.tick + c.length, t + opts.beat * 4);
    push(t, (stop - t) * 0.97, keyAtOrAbove(bassPc(c.chord), low), t === c.tick || i === 0 ? vel : vel * 0.9);
  });
  return out;
}

