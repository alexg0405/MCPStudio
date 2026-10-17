/**
 * Derived data shared by the engine and the UI, memoized by the identity of immutable inputs.
 * Semantics like pattern length, step projection and effective mute live only here.
 */
import type {
  Channel,
  ChannelId,
  InstrumentChannel,
  Note,
  NoteId,
  Pattern,
  Project,
  Tick,
  TimeSignature,
} from '../model/types';
import { TICKS_PER_STEP, ceilToBars, ticksPerBar } from '../time/ppq';

function memo1<K extends object, V>(fn: (k: K) => V): (k: K) => V {
  const cache = new WeakMap<K, V>();
  return (k) => {
    let v = cache.get(k);
    if (v === undefined) {
      v = fn(k);
      cache.set(k, v);
    }
    return v;
  };
}

const EMPTY_NOTES: readonly Note[] = Object.freeze([]);

/** A channel's notes sorted by start (then key). */
export const sortedNotes = memo1((notes: Readonly<Record<NoteId, Note>>): readonly Note[] =>
  Object.values(notes).sort((a, b) => a.tick - b.tick || a.key - b.key),
);

export function notesSorted(notes: Readonly<Record<NoteId, Note>> | undefined): readonly Note[] {
  return notes ? sortedNotes(notes) : EMPTY_NOTES;
}

/** Longest note length in a sorted list (lets range queries include long notes that started earlier). */
export const maxNoteLength = memo1((notes: readonly Note[]): number =>
  notes.reduce((m, n) => (n.length > m ? n.length : m), 0),
);

/** Index of the first note with tick >= `tick` (binary search). */
export function lowerBound(notes: readonly Note[], tick: Tick): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((notes[mid] as Note).tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Notes starting in [from, to). */
export function notesStartingIn(notes: readonly Note[], from: Tick, to: Tick): Note[] {
  const out: Note[] = [];
  for (let i = lowerBound(notes, from); i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.tick >= to) break;
    out.push(n);
  }
  return out;
}

/** Notes overlapping [from, to), including long notes that started before `from`. */
export function notesOverlapping(notes: readonly Note[], from: Tick, to: Tick): Note[] {
  const out: Note[] = [];
  const start = lowerBound(notes, from - maxNoteLength(notes));
  for (let i = start; i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.tick >= to) break;
    if (n.tick + n.length > from) out.push(n);
  }
  return out;
}

const lengthCache = new WeakMap<Pattern, Map<string, Tick>>();

/** Pattern length: explicit, or content (step grid and notes) rounded up to whole bars, at least one bar. */
export function patternLength(pattern: Pattern, ts: TimeSignature): Tick {
  if (pattern.length && pattern.length > 0) return pattern.length;
  const key = `${ts.num}/${ts.den}`;
  let byTs = lengthCache.get(pattern);
  const cached = byTs?.get(key);
  if (cached !== undefined) return cached;
  let end = pattern.stepCount * TICKS_PER_STEP;
  for (const cid in pattern.notes) {
    const notes = pattern.notes[cid as ChannelId];
    if (!notes) continue;
    for (const nid in notes) {
      const n = notes[nid as NoteId];
      if (n && n.tick + 1 > end) end = n.tick + 1;
    }
  }
  const len = ceilToBars(end, ts);
  if (!byTs) {
    byTs = new Map();
    lengthCache.set(pattern, byTs);
  }
  byTs.set(key, len);
  return len;
}

export interface StepView {
  /** True when every note is a plain step (renders as the step grid); false = show a mini piano roll. */
  isSteps: boolean;
  /** Velocity per step (0 = off), length = stepCount. */
  velocities: number[];
  /** The note on each step (null = off), for the graph editor. Only meaningful when `isSteps`. */
  notes: (Note | null)[];
}

const stepCache = new WeakMap<object, Map<number, StepView>>();

/**
 * Projects a channel's notes onto the step grid. FL semantics: steps are just notes that start on
 * a 1/16 boundary inside the grid, are at most one step long and don't share their step; each step
 * may have its own key (the graph editor's note pitch). Anything else shows as a mini piano roll.
 */
export function stepView(notes: Readonly<Record<NoteId, Note>> | undefined, stepCount: number): StepView {
  const host = notes ?? EMPTY_NOTES;
  let byCount = stepCache.get(host);
  const cached = byCount?.get(stepCount);
  if (cached) return cached;
  const velocities = new Array<number>(stepCount).fill(0);
  const stepNotes = new Array<Note | null>(stepCount).fill(null);
  let isSteps = true;
  for (const n of notesSorted(notes)) {
    const step = n.tick / TICKS_PER_STEP;
    if (!Number.isInteger(step) || n.length > TICKS_PER_STEP || step >= stepCount || stepNotes[step]) {
      isSteps = false;
      continue;
    }
    velocities[step] = Math.max(n.velocity, 0.0001);
    stepNotes[step] = n;
  }
  const view = { isSteps, velocities, notes: stepNotes };
  if (!byCount) {
    byCount = new Map();
    stepCache.set(host, byCount);
  }
  byCount.set(stepCount, view);
  return view;
}

/**
 * Audible channels that are silent because they are muted or because another channel is soloed
 * (automation channels make no sound, so their solo flags don't count).
 */
export const effectivelyMuted = memo1((channels: Readonly<Record<ChannelId, Channel>>): ReadonlySet<ChannelId> => {
  const list = Object.values(channels).filter((c) => c.kind !== 'automation');
  const anySolo = list.some((c) => c.solo);
  const out = new Set<ChannelId>();
  for (const c of list) if (c.muted || (anySolo && !c.solo)) out.add(c.id);
  return out;
});

export function instrumentChannels(project: Project): InstrumentChannel[] {
  const out: InstrumentChannel[] = [];
  for (const id of project.channelOrder) {
    const ch = project.channels[id];
    if (ch?.kind === 'instrument') out.push(ch);
  }
  return out;
}

/**
 * The lowest key of any unmuted note a channel plays in any pattern, or null when it has none. Instruments use it
 * to bound how long a sample can sound (a sampler plays lower keys slower), e.g. for the export's tail.
 */
export function lowestNoteKey(project: Project, channelId: ChannelId): number | null {
  let lowest: number | null = null;
  for (const pattern of Object.values(project.patterns)) {
    const notes = pattern.notes[channelId];
    if (!notes) continue;
    for (const n of Object.values(notes)) if (!n.muted && (lowest === null || n.key < lowest)) lowest = n.key;
  }
  return lowest;
}

export function barCount(ticks: Tick, ts: TimeSignature): number {
  return Math.ceil(ticks / ticksPerBar(ts));
}
