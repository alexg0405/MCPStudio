/** Transforms that create notes: arpeggiate, randomize and generate (scale-aware, seeded). */
import type { ScriptNote } from '../types';
import { scaleNotes, type KeyLike } from './scales';
import { byTime, clamp, clampNote, noteEnd, overlapGroups, withoutId, type Rand } from './util';

// ---------------------------------------------------------------------------------------------
// Arpeggiate

/**
 * - up / down: lowest to highest note, or the reverse;
 * - up-down / down-up: there and back without repeating the turning notes;
 * - converge: outside in (low, high, second lowest, …); diverge: inside out;
 * - as-played: in the order the notes start (a rolled chord keeps its order);
 * - random: a random note each step (never the same twice in a row).
 */
export type ArpPattern = 'up' | 'down' | 'up-down' | 'down-up' | 'converge' | 'diverge' | 'as-played' | 'random';
export const ARP_PATTERNS: readonly ArpPattern[] = [
  'up',
  'down',
  'up-down',
  'down-up',
  'converge',
  'diverge',
  'as-played',
  'random',
];

export interface ArpeggiateOptions {
  /** Ticks between the arpeggio's notes (240 = 1/16). */
  rate: number;
  /** 0–1: note length as a fraction of `rate` (default 0.9). */
  gate?: number;
  pattern?: ArpPattern;
  /** How many octaves the pattern climbs (1–8, default 1). */
  octaves?: number;
  /** Semitones above the lowest note the arpeggio may reach (0 = no limit). */
  range?: number;
  /** For the random pattern. */
  rand?: Rand;
}

function arpSequence(keys: number[], pattern: ArpPattern): number[] {
  const up = keys;
  const down = [...keys].reverse();
  switch (pattern) {
    case 'up':
    case 'as-played':
    case 'random':
      return up;
    case 'down':
      return down;
    case 'up-down':
      return up.length > 2 ? [...up, ...down.slice(1, -1)] : up;
    case 'down-up':
      return down.length > 2 ? [...down, ...up.slice(1, -1)] : down;
    case 'converge':
    case 'diverge': {
      const out: number[] = [];
      for (let lo = 0, hi = up.length - 1; lo <= hi; lo++, hi--) {
        out.push(up[lo] as number);
        if (hi !== lo) out.push(up[hi] as number);
      }
      return pattern === 'converge' ? out : out.reverse();
    }
  }
}

/**
 * Plays chords as arpeggios. Notes that overlap in time form a chord; its arpeggio runs from the
 * chord's first start to its last end at `rate`. Each arpeggio note copies the velocity, pan and
 * other settings of the chord note it plays. Every output note is new (no ids).
 */
export function arpeggiate(notes: readonly ScriptNote[], opts: ArpeggiateOptions): ScriptNote[] {
  const rate = Math.max(1, Math.round(opts.rate));
  const length = Math.max(1, Math.round(rate * clamp(opts.gate ?? 0.9, 0.01, 1)));
  const octaves = clamp(Math.round(opts.octaves ?? 1), 1, 8);
  const pattern = opts.pattern ?? 'up';
  const out: ScriptNote[] = [];
  for (const group of overlapGroups(notes)) {
    const start = group[0]?.tick ?? 0;
    const end = Math.max(...group.map(noteEnd));
    // One source note per key (the first to start), in the pattern's base order.
    const firstByKey = new Map<number, ScriptNote>();
    for (const n of group) if (!firstByKey.has(n.key)) firstByKey.set(n.key, n);
    const base = [...firstByKey.values()];
    if (pattern !== 'as-played') base.sort((a, b) => a.key - b.key);
    const lowest = Math.min(...base.map((n) => n.key));
    // Every key the arpeggio can play, with the note it copies.
    const source = new Map<number, ScriptNote>();
    for (let o = 0; o < octaves; o++)
      for (const n of base) {
        const key = n.key + 12 * o;
        if (key <= 127 && (!opts.range || key - lowest <= opts.range) && !source.has(key)) source.set(key, n);
      }
    if (source.size === 0) continue;
    const keys = [...source.keys()];
    if (pattern !== 'as-played') keys.sort((a, b) => a - b);
    const seq = arpSequence(keys, pattern);
    let previous = -1;
    for (let t = start, i = 0; t < end; t += rate, i++) {
      let pick = i % seq.length;
      if (pattern === 'random' && opts.rand) {
        pick = Math.floor(opts.rand() * seq.length);
        if (seq.length > 1 && pick === previous) pick = (pick + 1) % seq.length;
        previous = pick;
      }
      const key = seq[pick] as number;
      const from = source.get(key) as ScriptNote;
      out.push(clampNote({ ...withoutId(from), tick: t, length: Math.min(length, end - t), key }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Randomize existing notes

export interface RandomizeOptions {
  rand: Rand;
  /** Largest pitch change in semitones, either way (0 = keep pitches). */
  pitch?: number;
  /** Largest velocity change, either way (0–1). */
  velocity?: number;
  /** Random pitches stay in this key's scale. */
  key?: KeyLike | null;
}

/** Random pitch and velocity changes. Takes two `rand()` values per note. */
export function randomize(notes: readonly ScriptNote[], opts: RandomizeOptions): ScriptNote[] {
  const range = Math.max(0, Math.round(opts.pitch ?? 0));
  return notes.map((n) => {
    const rp = opts.rand();
    const rv = opts.rand();
    let key = n.key;
    if (range > 0) {
      const lo = Math.max(0, n.key - range);
      const hi = Math.min(127, n.key + range);
      const choices = opts.key ? scaleNotes(opts.key.root, opts.key.scale, lo, hi) : null;
      if (choices) key = choices.length ? (choices[Math.floor(rp * choices.length)] as number) : n.key;
      else key = lo + Math.floor(rp * (hi - lo + 1));
    }
    const dv = (rv * 2 - 1) * (opts.velocity ?? 0);
    const velocity = dv === 0 ? n.velocity : clamp(n.velocity + dv, 0.01, 1);
    return clampNote({ ...n, key, velocity });
  });
}

// ---------------------------------------------------------------------------------------------
// Generate new notes

export interface GenerateOptions {
  rand: Rand;
  /** Tick range to fill: [start, end). */
  start: number;
  end: number;
  /** Rhythm grid in ticks: at most one note (or chord) starts per cell. */
  grid: number;
  /** 0–1: chance that a note starts in a cell. */
  density: number;
  /** Key range, inclusive. */
  low: number;
  high: number;
  /** Note lengths in grid cells, inclusive (default 1–1). */
  minLength?: number;
  maxLength?: number;
  /** Velocity range, 0–1 (default 0.6–0.9). */
  minVelocity?: number;
  maxVelocity?: number;
  /** Keys come from this key's scale. */
  key?: KeyLike | null;
  /** Notes per started cell (1 = a melody). */
  polyphony?: number;
  /** 0–1: 0 picks any key in the range, 1 moves by single scale steps. */
  smoothness?: number;
  /** A note ends by the time the next one starts (default true). */
  monophonic?: boolean;
}

/**
 * Random notes in a key (FL's randomizer). Each cell takes the same number of `rand()` values
 * whatever the settings, so turning up the density adds notes without reshuffling the others.
 */
export function generate(opts: GenerateOptions): ScriptNote[] {
  const grid = Math.max(1, Math.round(opts.grid));
  const low = clamp(Math.round(Math.min(opts.low, opts.high)), 0, 127);
  const high = clamp(Math.round(Math.max(opts.low, opts.high)), 0, 127);
  const pool = opts.key ? scaleNotes(opts.key.root, opts.key.scale, low, high) : [];
  if (pool.length === 0) for (let k = low; k <= high; k++) pool.push(k);
  const minLen = Math.max(1, Math.round(opts.minLength ?? 1));
  const maxLen = Math.max(minLen, Math.round(opts.maxLength ?? minLen));
  const vLo = clamp(opts.minVelocity ?? 0.6, 0, 1);
  const vHi = Math.max(vLo, clamp(opts.maxVelocity ?? 0.9, 0, 1));
  const voices = clamp(Math.round(opts.polyphony ?? 1), 1, 8);
  const smooth = clamp(opts.smoothness ?? 0, 0, 1);
  const maxStep = Math.max(1, Math.round((1 - smooth) * (pool.length - 1)));
  const out: ScriptNote[] = [];
  let index = Math.floor(pool.length / 2);
  for (let t = Math.ceil(opts.start / grid) * grid; t < opts.end; t += grid) {
    const hit = opts.rand();
    const rLen = opts.rand();
    const rVel = opts.rand();
    const rKeys: number[] = [];
    for (let v = 0; v < voices; v++) rKeys.push(opts.rand());
    if (hit >= opts.density) continue;
    const cells = minLen + Math.floor(rLen * (maxLen - minLen + 1));
    const length = Math.min(cells * grid, opts.end - t);
    const velocity = vLo + rVel * (vHi - vLo);
    const used = new Set<number>();
    rKeys.forEach((r, v) => {
      let i: number;
      if (v === 0 && smooth > 0) {
        i = clamp(index + Math.round((r * 2 - 1) * maxStep), 0, pool.length - 1);
        index = i;
      } else i = Math.floor(r * pool.length);
      const key = pool[i] as number;
      if (used.has(key)) return;
      used.add(key);
      out.push(clampNote({ tick: t, length, key, velocity }));
    });
  }
  if (opts.monophonic === false) return out;
  // A note lasts at most until the next start.
  const starts = [...new Set(out.map((n) => n.tick))].sort((a, b) => a - b);
  const next = new Map(starts.map((s, i) => [s, starts[i + 1] ?? Infinity]));
  return byTime(out).map((n) => ({
    ...n,
    length: Math.max(1, Math.min(n.length, (next.get(n.tick) ?? Infinity) - n.tick)),
  }));
}
