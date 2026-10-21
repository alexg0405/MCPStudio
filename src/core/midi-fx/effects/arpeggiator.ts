/**
 * Arpeggiator: plays the notes that are held one after another on a grid. Steps are a pure function of the held notes and the
 * grid, never of a running state, so the same notes give the same steps whichever stretch of the song is asked for: the
 * scheduler can plan any window of the song, plan it again after an edit, or bake it, and the arpeggio stays in phase.
 *
 * A group is the stretch of time during which at least one note is held (notes that overlap belong together). Its steps
 * start with the group ("on key press") or on the song's grid ("next step of the song grid") and go on until the group ends. A
 * group always gets its first step, even when the key was let go before it (a quick tap between two grid steps still plays).
 */
import { p, type ParamValue } from '@agstudio/sdk/params';
import { draw, hashText } from '../random';
import { ARP_RATE_IDS, noteValueLabels, noteValueTicks } from '../rates';
import { clampVelocity, MAX_KEY, noteLike, TICK_EPSILON } from '../note-utils';
import type { FxNote, FxRun, MidiFxDef } from '../types';

const PATTERNS = ['up', 'down', 'upDown', 'random', 'played', 'chord'];
const PATTERN_LABELS = { up: 'Up', down: 'Down', upDown: 'Up and down', random: 'Random', played: 'As played', chord: 'Chord' };
const SYNCS = ['key', 'song'];
const VELOCITY_MODES = ['played', 'fixed', 'accent'];
/** An octave in semitones. */
const OCTAVE = 12;
/** How far past its group's end a step can land: the first step of a group tapped between two grid steps, plus swing and gate. */
const REACH_STEPS = 2;

/** The stretch of time during which notes are held, with those notes sorted by start. */
interface Group {
  /** The id of the group's first note: the steps' ids are derived from it. */
  id: string;
  start: number;
  end: number;
  notes: FxNote[];
  /** Latched: every note of the group is held until the next group starts. */
  latched: boolean;
}

/** Splits notes into groups of overlapping notes; with `latch`, each group is held until the next one starts. */
function findGroups(input: readonly FxNote[], latch: boolean): Group[] {
  const sorted = [...input].sort((a, b) => a.start - b.start || a.key - b.key);
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const note of sorted) {
    if (current && note.start < current.end - TICK_EPSILON) {
      current.notes.push(note);
      current.end = Math.max(current.end, note.end);
    } else {
      current = { id: note.id, start: note.start, end: note.end, notes: [note], latched: latch };
      groups.push(current);
    }
  }
  if (latch) {
    groups.forEach((group, i) => {
      group.end = groups[i + 1]?.start ?? Infinity;
    });
  }
  return groups;
}

/** The notes of the group that are held at `tick`, lowest key first. */
function heldAt(group: Group, tick: number): FxNote[] {
  const held = group.notes.filter((note) => {
    const end = group.latched ? group.end : note.end;
    return note.start <= tick + TICK_EPSILON && tick < end;
  });
  return held.sort((a, b) => a.key - b.key || a.start - b.start);
}

/** The notes a step can pick from, in playing order for "up": every held note, then again an octave higher, for each octave. */
function stepPool(held: readonly FxNote[], inPlayedOrder: boolean, octaves: number): { note: FxNote; key: number }[] {
  const ordered = inPlayedOrder ? [...held].sort((a, b) => a.start - b.start || a.key - b.key) : held;
  const pool: { note: FxNote; key: number }[] = [];
  for (let octave = 0; octave < octaves; octave++) {
    for (const note of ordered) {
      const key = note.key + OCTAVE * octave;
      if (key <= MAX_KEY) pool.push({ note, key });
    }
  }
  return pool;
}

/** Which entry of a pool of `size` the step numbered `step` plays, for the patterns that walk the pool. */
function poolIndex(pattern: string, step: number, size: number, randomDraw: number): number {
  switch (pattern) {
    case 'down':
      return size - 1 - (step % size);
    case 'upDown': {
      if (size === 1) return 0;
      const period = 2 * size - 2;
      const position = step % period;
      return position < size ? position : period - position;
    }
    case 'random':
      return Math.min(size - 1, Math.floor(randomDraw * size));
    default:
      return step % size;
  }
}

/** The velocity of one step: as played, a fixed level, or accented on every Nth step. */
function stepVelocity(played: number, step: number, run: FxRun, at: number): number {
  const mode = String(run.values.velocity);
  if (mode === 'fixed') return run.param('level', at);
  if (mode === 'accent') {
    const every = Math.max(1, Math.round(Number(run.values.accentEvery)));
    return step % every === 0 ? played : played * (1 - run.param('accentDepth', at));
  }
  return played;
}

/** The notes one step plays: one note for most patterns, the whole held chord for "Chord". */
function stepNotes(group: Group, held: readonly FxNote[], step: number, at: number, run: FxRun): { note: FxNote; key: number }[] {
  const pattern = String(run.values.pattern);
  const octaves = Math.max(1, Math.round(Number(run.values.octaves)));
  if (pattern === 'chord') {
    const shift = OCTAVE * (step % octaves);
    return held.filter((note) => note.key + shift <= MAX_KEY).map((note) => ({ note, key: note.key + shift }));
  }
  const pool = stepPool(held, pattern === 'played', octaves);
  if (pool.length === 0) return [];
  const randomDraw = pattern === 'random' ? draw(run.seed, hashText(group.id), step) : 0;
  const picked = pool[poolIndex(pattern, step, pool.length, randomDraw)];
  return picked ? [picked] : [];
}

/** The steps of one group whose start lies in the run's span. */
function groupSteps(group: Group, run: FxRun, out: FxNote[]): void {
  const stepTicks = noteValueTicks(String(run.values.rate));
  const onSongGrid = String(run.values.sync) === 'song';
  const base = onSongGrid ? Math.ceil(group.start / stepTicks - TICK_EPSILON) * stepTicks : group.start;
  // Parity of a step on the song's own grid does not depend on where the group starts, so a swung arpeggio keeps its groove.
  const gridIndex = onSongGrid ? Math.round(base / stepTicks) : 0;
  const firstStep = Math.max(0, Math.floor((run.from - base) / stepTicks) - 1);
  for (let step = firstStep; ; step++) {
    const at = base + step * stepTicks;
    if (at >= run.to) break;
    if (step > 0 && at >= group.end - TICK_EPSILON) break;
    let held = heldAt(group, at);
    // A key let go before its first step still plays that step, with the notes that were held when the group ended.
    if (held.length === 0) held = heldAt(group, group.end - TICK_EPSILON);
    const odd = (gridIndex + step) % 2 === 1;
    const start = at + (odd ? run.param('swing', at) * stepTicks * 0.5 : 0);
    const end = start + Math.max(1, run.param('gate', at) * stepTicks);
    stepNotes(group, held, step, at, run).forEach(({ note, key }, i) => {
      const velocity = clampVelocity(stepVelocity(note.velocity, step, run, at));
      out.push(noteLike(`${group.id}:a${step}.${i}`, note, { start, end, key, velocity }));
    });
  }
}

/** Arpeggiator: see the file comment. */
export const arpeggiator: MidiFxDef = {
  id: 'arp',
  name: 'Arpeggiator',
  short: 'ARP',
  description: 'Plays the notes you hold one after another in time with the song: up, down, up and down, random, as played, or the whole chord on every step.',
  params: {
    pattern: p.enum(PATTERNS, 'up', { group: 'Pattern', label: 'Pattern', labels: PATTERN_LABELS, hint: 'The order the held notes are played in' }),
    rate: p.enum(ARP_RATE_IDS, '1/16', { group: 'Pattern', label: 'Rate', labels: noteValueLabels(ARP_RATE_IDS), hint: 'How long each step is, as a note value of the song tempo' }),
    octaves: p.int(1, 4, 1, { group: 'Pattern', label: 'Octaves', hint: 'How many octaves the arpeggio climbs before it starts over' }),
    gate: p.float(0.05, 1.5, 0.8, { group: 'Feel', label: 'Gate', unit: '%', hint: 'How long each note lasts as a share of its step (above 100% they overlap)' }),
    swing: p.float(0, 1, 0, { group: 'Feel', label: 'Swing', unit: '%', hint: 'Plays every second step late, up to half a step' }),
    sync: p.enum(SYNCS, 'key', {
      group: 'Start',
      label: 'Start',
      labels: { key: 'On key press', song: 'Next step of the song grid' },
      hint: 'Whether the first step plays the moment the key goes down or waits for the next step of the song grid',
    }),
    latch: p.bool(false, { group: 'Start', label: 'Latch', hint: 'Keeps playing after you let go, until you play new notes' }),
    velocity: p.enum(VELOCITY_MODES, 'played', {
      group: 'Velocity',
      label: 'Velocity',
      labels: { played: 'As played', fixed: 'Fixed level', accent: 'Accent pattern' },
      hint: 'Where each step’s loudness comes from',
    }),
    level: p.float(0.01, 1, 0.8, { group: 'Velocity', label: 'Level', unit: '%', hint: 'The loudness of every step when Velocity is Fixed level' }),
    accentEvery: p.int(1, 8, 4, { group: 'Velocity', label: 'Accent every', hint: 'With Accent pattern: every this many steps is played at full strength' }),
    accentDepth: p.float(0, 1, 0.5, { group: 'Velocity', label: 'Accent depth', unit: '%', hint: 'With Accent pattern: how much quieter the steps between the accents are' }),
    seed: p.int(0, 9999, 1, { group: 'Random', label: 'Seed', automatable: false, hint: 'Which random pattern: the same seed always plays the same one' }),
  },
  presets: [
    { name: 'Up 1/16', params: {} },
    { name: 'Up and down 1/8, two octaves', params: { pattern: 'upDown', rate: '1/8', octaves: 2 } },
    { name: 'Trance gate', params: { pattern: 'up', rate: '1/16', octaves: 3, gate: 0.5, velocity: 'accent', accentEvery: 4, accentDepth: 0.45 } },
    { name: 'Random triplets', params: { pattern: 'random', rate: '1/16t', octaves: 2, gate: 0.6 } },
    { name: 'Chord stabs 1/8', params: { pattern: 'chord', rate: '1/8', gate: 0.35 } },
    { name: 'Bouncy swing', params: { pattern: 'upDown', rate: '1/16', swing: 0.55, gate: 0.7 } },
    { name: 'Latched pad arp', params: { pattern: 'up', rate: '1/8', octaves: 2, latch: true, sync: 'song' } },
  ],
  reach(values: Readonly<Record<string, ParamValue>>) {
    return { before: 0, after: REACH_STEPS * noteValueTicks(String(values.rate)) };
  },
  run(input, run) {
    const out: FxNote[] = [];
    for (const group of findGroups(input, Boolean(run.values.latch))) {
      if (group.start >= run.to) break;
      // A group that ended long before the span has no step in it (its last step is at most REACH_STEPS steps past its end).
      const stepTicks = noteValueTicks(String(run.values.rate));
      if (group.end + REACH_STEPS * stepTicks < run.from) continue;
      groupSteps(group, run, out);
    }
    return out;
  },
};
