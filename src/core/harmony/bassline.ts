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

/** Default 808 pattern when the song has no kick to follow: 16th steps within a bar. */
export const DEFAULT_808_STEPS: readonly number[] = [0, 6, 10];

/** The lowest key a bass line uses (MIDI): 33 (A1) for a bass, 28 (E1) for an 808. */
const DEFAULT_LOW_BASS = 33;
const DEFAULT_LOW_808 = 28;
/** Notes are held this share of the time they could last, so each has a short gap before the next. */
const ROOTS_GATE = 0.95;
const ROOT_FIFTH_GATE = 0.9;
const WALKING_GATE = 0.92;
const HOLD_808_GATE = 0.97;
/** Notes after the first of a chord play at this share of the velocity. */
const REPEAT_VELOCITY = 0.9;
const OFFBEAT_VELOCITY = 0.85;
/** Walking: a line stays within this many semitones above the lowest key. */
const WALKING_RANGE = 19;
/** Walking: the chance that a bar's approach note is a scale step away rather than a half step. */
const SCALE_STEP_APPROACH = 0.35;
/** 808: hits closer than this many ticks are one hit; an 808 note rings at most this many beats. */
const MIN_HIT_GAP = 10;
const MAX_808_BEATS = 4;
/** The fifth goes down an octave's worth (a fourth below) when going up would pass this many semitones above `low`. */
const FIFTH_CEILING = 14;

/** The lowest key at or above `low` with this pitch class. */
const keyAtOrAbove = (pc: number, low: number): number => low + mod12(pc - low);

/** The chord (and its index) sounding at a tick. */
function chordAt(chords: readonly BassChord[], tick: number): BassChord | null {
  let hit: BassChord | null = null;
  for (const entry of chords) if (entry.tick <= tick && tick < entry.tick + entry.length) hit = entry;
  return hit;
}

/** The pitch class the bass plays under a chord: its slash bass, else its root. */
const bassPc = (entry: ChordSymbol) => (entry.bass !== undefined ? mod12(entry.bass) : mod12(entry.root));

/** A small seeded random generator (mulberry32): the same seed gives the same walking line. */
function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collects the notes of one bassline: nothing past the end, lengths and ticks rounded to whole ticks. */
class LineWriter {
  readonly notes: BassNote[] = [];

  constructor(
    private readonly end: number,
    readonly velocity: number,
  ) {}

  push(tick: number, length: number, key: number, velocity = this.velocity): void {
    if (length < 1 || tick >= this.end) return;
    this.notes.push({
      tick: Math.round(tick),
      length: Math.max(1, Math.round(Math.min(length, this.end - tick))),
      key,
      velocity,
    });
  }
}

/** A bassline for the chords. Notes never overlap each other and stop where the next chord starts. */
export function makeBassline(chordsIn: readonly BassChord[], opts: BassOptions): BassNote[] {
  const chords = [...chordsIn].filter((entry) => entry.length > 0).sort((a, b) => a.tick - b.tick);
  if (chords.length === 0) return [];
  const end = opts.end ?? Math.max(...chords.map((entry) => entry.tick + entry.length));
  const low = opts.low ?? (opts.style === '808' ? DEFAULT_LOW_808 : DEFAULT_LOW_BASS);
  const line = new LineWriter(end, opts.velocity ?? 0.85);
  switch (opts.style) {
    case 'roots':
      rootsLine(chords, line, opts, low);
      break;
    case 'root-fifth':
      rootFifthLine(chords, line, opts, low);
      break;
    case 'walking':
      walkingLine(chords, line, opts, low);
      break;
    default:
      eightOhEightLine(chords, line, opts, low, end);
  }
  return line.notes;
}

/** Roots: one note per bar line inside the chord so a long chord keeps breathing. */
function rootsLine(chords: readonly BassChord[], line: LineWriter, opts: BassOptions, low: number): void {
  const vel = line.velocity;
  for (const entry of chords) {
    const key = keyAtOrAbove(bassPc(entry.chord), low);
    for (let t = entry.tick; t < entry.tick + entry.length;) {
      const barEnd = (Math.floor(t / opts.bar) + 1) * opts.bar;
      const stop = Math.min(entry.tick + entry.length, barEnd);
      line.push(t, (stop - t) * ROOTS_GATE, key, t === entry.tick ? vel : vel * REPEAT_VELOCITY);
      t = stop;
    }
  }
}

/** Root and fifth on alternate beats; the fifth goes up, or down when that keeps the line in range. */
function rootFifthLine(chords: readonly BassChord[], line: LineWriter, opts: BassOptions, low: number): void {
  const vel = line.velocity;
  for (const entry of chords) {
    const root = keyAtOrAbove(bassPc(entry.chord), low);
    const fifth = root + 7 > low + FIFTH_CEILING ? root - 5 : root + 7;
    let i = 0;
    for (let t = entry.tick; t < entry.tick + entry.length; t += opts.beat, i++) {
      const len = Math.min(opts.beat, entry.tick + entry.length - t);
      line.push(t, len * ROOT_FIFTH_GATE, i % 2 === 0 ? root : fifth, i === 0 ? vel : vel * OFFBEAT_VELOCITY);
    }
  }
}

/** A walking line: the root on each chord's first beat, chord tones between, an approach note into the next chord. */
function walkingLine(chords: readonly BassChord[], line: LineWriter, opts: BassOptions, low: number): void {
  const vel = line.velocity;
  const random = seededRandom(opts.seed ?? 1);
  const scale = opts.key ? scalePitchClasses(opts.key) : null;
  let prev = -1;
  const nearest = (pc: number, around: number): number => {
    let best = keyAtOrAbove(pc, low);
    for (let k = best; k <= low + WALKING_RANGE; k += 12) if (Math.abs(k - around) < Math.abs(best - around)) best = k;
    return best;
  };
  /** Approaches the next chord's root from a half step or (sometimes) a scale step, below or above. */
  const approach = (next: BassChord, root: number): number => {
    const from = prev < 0 ? root : prev;
    const target = nearest(bassPc(next.chord), from);
    const near = [target - 1, target + 1];
    const step = scale ? [target - 2, target + 2].filter((k) => scale.includes(mod12(k))) : [];
    const pool = (step.length && random() < SCALE_STEP_APPROACH ? step : near).filter(
      (k) => k >= low && k <= low + WALKING_RANGE,
    );
    return (pool.length ? pool : near).reduce((best, k) => (Math.abs(k - from) < Math.abs(best - from) ? k : best));
  };
  chords.forEach((entry, ci) => {
    const following = chords[ci + 1];
    const next = following?.tick === entry.tick + entry.length ? following : (following ?? chords[0] ?? entry);
    const root = keyAtOrAbove(bassPc(entry.chord), low);
    const tones = chordPitchClasses(entry.chord).filter((pc) => pc !== bassPc(entry.chord));
    const beats = Math.max(1, Math.round(entry.length / opts.beat));
    for (let b = 0; b < beats; b++) {
      const t = entry.tick + b * opts.beat;
      const len = Math.min(opts.beat, entry.tick + entry.length - t);
      let key: number;
      if (b === 0) key = root;
      else if (b === beats - 1 && beats > 1) key = approach(next as BassChord, root);
      else {
        const pcs = tones.length ? tones : [bassPc(entry.chord)];
        const pc = pcs[Math.floor(random() * pcs.length)] as number;
        key = nearest(pc, prev < 0 ? root + 4 : prev);
        if (key === prev) key = nearest(pcs[(pcs.indexOf(pc) + 1) % pcs.length] as number, prev);
      }
      line.push(t, len * WALKING_GATE, key, b === 0 ? vel : vel * OFFBEAT_VELOCITY);
      prev = key;
    }
  });
}

/** The ticks the kick hits, cycle after cycle up to `end` (the default pattern in 16ths when the song has none). */
function kickHits(opts: BassOptions, end: number): number[] {
  const cycle = Math.max(1, Math.round(opts.cycle ?? opts.bar));
  const kicks =
    opts.kicks && opts.kicks.length ? [...opts.kicks] : DEFAULT_808_STEPS.map((s) => Math.round((s * opts.bar) / 16));
  const hits: number[] = [];
  for (let base = 0; base < end; base += cycle) {
    for (const k of kicks) if (base + k < end && base + k >= 0) hits.push(base + k);
  }
  return hits;
}

/** 808: the kick's hits, each playing the chord's bass note until the next hit (or the chord changes). */
function eightOhEightLine(
  chords: readonly BassChord[],
  line: LineWriter,
  opts: BassOptions,
  low: number,
  end: number,
): void {
  const vel = line.velocity;
  const hits = kickHits(opts, end);
  // An 808 changes pitch with the chord, so each chord starts a note even where the kick does not.
  for (const entry of chords) if (!hits.some((h) => Math.abs(h - entry.tick) < opts.bar / 32)) hits.push(entry.tick);
  hits.sort((a, b) => a - b);
  const distinctHits = hits.filter((hit, index) => index === 0 || hit - (hits[index - 1] as number) > MIN_HIT_GAP);
  distinctHits.forEach((hitTick, index) => {
    const entry = chordAt(chords, hitTick);
    if (!entry) return;
    const nextHit = distinctHits[index + 1] ?? end;
    const stop = Math.min(nextHit, entry.tick + entry.length, hitTick + opts.beat * MAX_808_BEATS);
    const isAccent = hitTick === entry.tick || index === 0;
    line.push(
      hitTick,
      (stop - hitTick) * HOLD_808_GATE,
      keyAtOrAbove(bassPc(entry.chord), low),
      isAccent ? vel : vel * REPEAT_VELOCITY,
    );
  });
}
