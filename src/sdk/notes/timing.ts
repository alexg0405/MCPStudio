/**
 * Timing and edit transforms: quantize, humanize, legato, chop, glue, strum, flip, stretch.
 * Each returns new notes; notes keep their `id` when they are edits of an input note.
 */
import type { ScriptNote } from '../types';
import { bend, byTime, chordGroups, clamp, clampNote, noteEnd, span, withoutId, type Rand } from './util';

// ---------------------------------------------------------------------------------------------
// Quantize

/** Settings for `quantize`. */
export interface QuantizeOptions {
  /** Grid size in ticks (a note script's `ctx.grid` is the piano roll's snap). */
  grid: number;
  /** 0–1: how far notes move towards the grid (1 = all the way, the default). */
  strength?: number;
  /** Quantize note starts (default true). */
  starts?: boolean;
  /** Snap note ends to the grid as well (default false: lengths are kept). */
  ends?: boolean;
  /** Round lengths to whole grid cells (default false; ignored when `ends` is set). */
  lengths?: boolean;
  /** 0–1: every second grid line is late by swing × half a cell, like the song's swing. */
  swing?: number;
  /** 0–1: only starts within window × half a cell of their line move (default 1 = all of them). */
  window?: number;
}

/** Grid line `k`, where odd lines are late by the swing. */
function gridLine(k: number, grid: number, swing: number): number {
  return k * grid + (k % 2 !== 0 ? (swing * grid) / 2 : 0);
}

/** The (swung) grid line nearest to `t`; ties go to the earlier line. */
export function nearestGridLine(t: number, grid: number, swing = 0): number {
  const k0 = Math.floor(t / grid);
  let best = gridLine(k0 - 1, grid, swing);
  for (let k = k0; k <= k0 + 2; k++) {
    const line = gridLine(k, grid, swing);
    if (Math.abs(line - t) < Math.abs(best - t)) best = line;
  }
  return best;
}

/** The first (swung) grid line after `t`. */
function nextGridLine(t: number, grid: number, swing: number): number {
  for (let k = Math.floor(t / grid) - 1; ; k++) {
    const line = Math.round(gridLine(k, grid, swing));
    if (line > t) return line;
  }
}

/**
 * Moves notes towards the grid. At strength 1 starts land exactly on grid lines (swung ones when
 * `swing` is set) and quantizing again changes nothing.
 */
export function quantize(notes: readonly ScriptNote[], opts: QuantizeOptions): ScriptNote[] {
  const grid = Math.max(1, opts.grid);
  const strength = clamp(opts.strength ?? 1, 0, 1);
  const swing = clamp(opts.swing ?? 0, 0, 1);
  const window = opts.window ?? 1;
  return notes.map((n) => {
    let start = n.tick;
    if (opts.starts !== false) {
      const target = Math.round(nearestGridLine(n.tick, grid, swing));
      if (window >= 1 || Math.abs(target - n.tick) <= (window * grid) / 2)
        start = Math.round(n.tick + strength * (target - n.tick));
    }
    let length = n.length;
    if (opts.ends) {
      const end = noteEnd(n);
      let target = Math.round(nearestGridLine(end, grid, swing));
      if (target <= start) target = nextGridLine(start, grid, swing);
      length = Math.round(end + strength * (target - end)) - start;
    } else if (opts.lengths) {
      const target = Math.max(grid, Math.round(n.length / grid) * grid);
      length = Math.round(n.length + strength * (target - n.length));
    }
    return clampNote({ ...n, tick: start, length: Math.max(1, length) });
  });
}

// ---------------------------------------------------------------------------------------------
// Humanize

/** Settings for `humanize`. */
export interface HumanizeOptions {
  rand: Rand;
  /** Largest timing change in ticks, either way (960 = a beat). */
  timing?: number;
  /** Largest velocity change, either way (0–1). */
  velocity?: number;
  /** Largest length change as a fraction of the length, either way (0–1). */
  length?: number;
}

/** Random variations in timing, velocity and length. Takes three `rand()` values per note. */
export function humanize(notes: readonly ScriptNote[], opts: HumanizeOptions): ScriptNote[] {
  return notes.map((n) => {
    const dt = (opts.rand() * 2 - 1) * (opts.timing ?? 0);
    const dv = (opts.rand() * 2 - 1) * (opts.velocity ?? 0);
    const dl = (opts.rand() * 2 - 1) * (opts.length ?? 0);
    return clampNote({
      ...n,
      tick: n.tick + dt,
      // A sounding note stays audible.
      velocity: dv === 0 ? n.velocity : n.velocity > 0 ? Math.max(0.01, n.velocity + dv) : n.velocity,
      length: n.length * (1 + dl),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Legato

/** Settings for `legato`. */
export interface LegatoOptions {
  /** Ticks left between a note's end and the next start (default 0). */
  gap?: number;
  /** Where the last notes end; absent, they keep their length. */
  until?: number;
}

/**
 * Every note lasts until the next start (notes that start together, chords, end together), so a
 * melodic line has no gaps and no overlaps.
 */
export function legato(notes: readonly ScriptNote[], opts: LegatoOptions = {}): ScriptNote[] {
  const starts = [...new Set(notes.map((n) => n.tick))].sort((a, b) => a - b);
  const next = new Map<number, number>();
  starts.forEach((t, i) => {
    const following = starts[i + 1] ?? opts.until;
    if (following !== undefined) next.set(t, following);
  });
  const gap = Math.max(0, opts.gap ?? 0);
  return notes.map((n) => {
    const until = next.get(n.tick);
    if (until === undefined || until <= n.tick) return { ...n };
    return clampNote({ ...n, length: Math.max(1, until - n.tick - gap) });
  });
}

// ---------------------------------------------------------------------------------------------
// Chop and glue

/** Settings for `chop`. */
export interface ChopOptions {
  /** Cut at every multiple of this many ticks (grid lines)… */
  grid?: number;
  /** …or into this many equal parts (when `grid` is absent). */
  parts?: number;
  /** 0–1: each piece's length as a fraction of its slot (default 1: the pieces touch). */
  gate?: number;
}

/** Cuts notes into pieces. The first piece keeps the note's id; the others are new notes. */
export function chop(notes: readonly ScriptNote[], opts: ChopOptions): ScriptNote[] {
  const gate = clamp(opts.gate ?? 1, 0, 1);
  const out: ScriptNote[] = [];
  for (const n of notes) {
    const start = n.tick;
    const end = noteEnd(n);
    const cuts: number[] = [start];
    if (opts.grid !== undefined) {
      const g = Math.max(1, opts.grid);
      for (let t = (Math.floor(start / g) + 1) * g; t < end; t += g) cuts.push(Math.round(t));
    } else {
      const parts = Math.max(1, Math.min(Math.round(opts.parts ?? 2), n.length));
      for (let i = 1; i < parts; i++) cuts.push(start + Math.floor((i * n.length) / parts));
    }
    cuts.push(end);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i] as number;
      const b = cuts[i + 1] as number;
      if (b <= a) continue;
      const base = i === 0 ? n : withoutId(n);
      out.push(clampNote({ ...base, tick: a, length: Math.max(1, Math.round((b - a) * gate)) }));
    }
  }
  return out;
}

/** Settings for `glue`. */
export interface GlueOptions {
  /** Same-key notes this many ticks apart (or closer, or overlapping) are joined. Default 0 (touching). */
  gap?: number;
}

/** Joins same-key notes that touch or overlap into one; the first note of each run keeps its id. */
export function glue(notes: readonly ScriptNote[], opts: GlueOptions = {}): ScriptNote[] {
  const gap = Math.max(0, opts.gap ?? 0);
  const byKey = new Map<number, ScriptNote[]>();
  for (const n of byTime(notes)) {
    const list = byKey.get(n.key);
    if (list) list.push(n);
    else byKey.set(n.key, [n]);
  }
  const out: ScriptNote[] = [];
  for (const list of byKey.values()) {
    let head = list[0] as ScriptNote;
    let end = noteEnd(head);
    for (let i = 1; i <= list.length; i++) {
      const n = list[i];
      if (n && n.tick - end <= gap) {
        end = Math.max(end, noteEnd(n));
        continue;
      }
      out.push({ ...head, length: end - head.tick });
      if (n) {
        head = n;
        end = noteEnd(n);
      }
    }
  }
  return byTime(out);
}

// ---------------------------------------------------------------------------------------------
// Strum

/** Settings for `strum`. */
export interface StrumOptions {
  /** Ticks from the first to the last note of each chord. */
  time: number;
  /** Order of the notes: up (lowest first), down, alternate (up, down, up…) or random. */
  direction?: 'up' | 'down' | 'alternate' | 'random';
  /** −1…1: 0 spaces the notes evenly; positive starts close together and spreads out, negative the opposite. */
  curve?: number;
  /** Notes starting within this many ticks of each other form a chord (default 0: the same tick). */
  tolerance?: number;
  /** Keep note ends in place so later notes get shorter (default true). */
  keepEnds?: boolean;
  /** −1…1: velocity change across the strum (−0.3 = the last note 30% softer). */
  velocity?: number;
  /** For `direction: 'random'`. */
  rand?: Rand;
}

/** Spreads the notes of each chord out in time, like strumming a guitar. */
export function strum(notes: readonly ScriptNote[], opts: StrumOptions): ScriptNote[] {
  const time = Math.max(0, opts.time);
  const keepEnds = opts.keepEnds ?? true;
  const out: ScriptNote[] = [];
  chordGroups(notes, opts.tolerance ?? 0).forEach((group, gi) => {
    if (group.length < 2) {
      out.push(...group.map((n) => ({ ...n })));
      return;
    }
    let order = [...group];
    const dir = opts.direction ?? 'up';
    if (dir === 'down' || (dir === 'alternate' && gi % 2 === 1)) order.reverse();
    else if (dir === 'random' && opts.rand) {
      const rand = opts.rand;
      order = shuffle(order, rand);
    }
    const start = Math.min(...group.map((n) => n.tick));
    order.forEach((n, i) => {
      const x = i / (order.length - 1);
      const tick = start + Math.round(time * bend(x, opts.curve ?? 0));
      const length = keepEnds ? Math.max(1, noteEnd(n) - tick) : n.length;
      const velocity = n.velocity * (1 + clamp(opts.velocity ?? 0, -1, 1) * x);
      out.push(clampNote({ ...n, tick, length, velocity }));
    });
  });
  return out;
}

function shuffle<T>(items: T[], rand: Rand): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// Flip and stretch

/** The range `flip` mirrors in (it defaults to the notes' own range). */
export interface FlipBounds {
  /** Time range to mirror in (default: from the first start to the last end). */
  start?: number;
  end?: number;
  /** Key range to mirror in (default: the lowest to the highest key). */
  low?: number;
  high?: number;
}

/**
 * Mirrors notes in time (the last note becomes the first) or in pitch (around the centre of their
 * key range). Flipping twice gives the original notes.
 */
export function flip(notes: readonly ScriptNote[], axis: 'time' | 'pitch', bounds: FlipBounds = {}): ScriptNote[] {
  const s = span(notes);
  if (!s) return [];
  if (axis === 'time') {
    const sum = (bounds.start ?? s.start) + (bounds.end ?? s.end);
    return notes.map((n) => clampNote({ ...n, tick: sum - noteEnd(n) }));
  }
  const sum = (bounds.low ?? s.low) + (bounds.high ?? s.high);
  return notes.map((n) => clampNote({ ...n, key: sum - n.key }));
}

/** Settings for `stretch`. */
export interface StretchOptions {
  /** 2 = twice as long (half time), 0.5 = double time. */
  factor: number;
  /** Tick that stays in place (default: the first note's start). */
  anchor?: number;
}

/** Scales note positions and lengths in time. */
export function stretch(notes: readonly ScriptNote[], opts: StretchOptions): ScriptNote[] {
  const s = span(notes);
  if (!s || !(opts.factor > 0)) return notes.map((n) => ({ ...n }));
  const anchor = opts.anchor ?? s.start;
  return notes.map((n) =>
    clampNote({ ...n, tick: anchor + (n.tick - anchor) * opts.factor, length: n.length * opts.factor }),
  );
}
