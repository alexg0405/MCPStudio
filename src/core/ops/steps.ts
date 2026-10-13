/**
 * Channel-rack step sequencer actions (FL's channel menu): fill every N steps, rotate, shift,
 * reverse, randomize and clear one channel's notes in a pattern. Draft mutators.
 */
import { current as snapshot, isDraft, type Draft } from 'immer';
import { newId } from '../model/ids';
import type { ChannelId, Note, NoteId, PatternId, Project, Tick } from '../model/types';
import { notesSorted, patternLength, stepView } from '../query/queries';
import { TICKS_PER_STEP } from '../time/ppq';
import { addNotes, editNotes, removeNotes } from './notes';

const DEFAULT_VELOCITY = 100 / 128;

/** The channel's notes as plain values, sorted (sorting the draft itself would proxy every note). */
function current(d: Draft<Project>, patternId: PatternId, channelId: ChannelId): readonly Note[] {
  const notes = d.patterns[patternId]?.notes[channelId];
  if (!notes) return [];
  return notesSorted((isDraft(notes) ? snapshot(notes) : notes) as Record<NoteId, Note>);
}

/** The span rotate and shift wrap in: the step grid, or the whole pattern when notes start past it. */
function cycle(d: Draft<Project>, patternId: PatternId, notes: readonly Note[]): Tick {
  const pattern = d.patterns[patternId];
  if (!pattern) return 0;
  const grid = pattern.stepCount * TICKS_PER_STEP;
  return notes.every((n) => n.tick < grid) ? grid : patternLength(pattern, d.transport.timeSig);
}

/** Removes every note of the channel in the pattern. */
export function clearSteps(d: Draft<Project>, patternId: PatternId, channelId: ChannelId): void {
  const pattern = d.patterns[patternId];
  if (pattern?.notes[channelId]) delete pattern.notes[channelId];
}

/** Replaces the channel's notes with a step every `every` steps (FL "Fill each 2/4/8 steps"). */
export function fillSteps(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  every: number,
  opts: { rootKey: number; velocity?: number },
): void {
  const pattern = d.patterns[patternId];
  if (!pattern || every < 1) return;
  clearSteps(d, patternId, channelId);
  const notes: Note[] = [];
  for (let s = 0; s < pattern.stepCount; s += Math.round(every)) {
    notes.push({
      id: newId.note(),
      tick: s * TICKS_PER_STEP,
      length: TICKS_PER_STEP,
      key: opts.rootKey,
      velocity: opts.velocity ?? DEFAULT_VELOCITY,
    });
  }
  addNotes(d, patternId, channelId, notes);
}

/** Moves the channel's notes by whole steps, wrapping around the end of the step grid. */
export function rotateSteps(d: Draft<Project>, patternId: PatternId, channelId: ChannelId, steps: number): void {
  const notes = current(d, patternId, channelId);
  const len = cycle(d, patternId, notes);
  if (notes.length === 0 || len <= 0) return;
  const by = Math.round(steps) * TICKS_PER_STEP;
  editNotes(
    d,
    patternId,
    channelId,
    notes.map((n) => ({ id: n.id, tick: (((n.tick + by) % len) + len) % len })),
  );
}

/** Moves the channel's notes by whole steps; notes that leave the step grid are removed. */
export function shiftSteps(d: Draft<Project>, patternId: PatternId, channelId: ChannelId, steps: number): void {
  const notes = current(d, patternId, channelId);
  const len = cycle(d, patternId, notes);
  const by = Math.round(steps) * TICKS_PER_STEP;
  if (notes.length === 0 || by === 0) return;
  const gone: NoteId[] = [];
  const moved = [];
  for (const n of notes) {
    const tick = n.tick + by;
    if (tick < 0 || tick >= len) gone.push(n.id);
    else moved.push({ id: n.id, tick });
  }
  removeNotes(d, patternId, channelId, gone);
  editNotes(d, patternId, channelId, moved);
}

/**
 * Reverses the channel's notes: steps play backwards (step i ↔ step n − 1 − i); other notes are
 * mirrored in time over the pattern.
 */
export function reverseSteps(d: Draft<Project>, patternId: PatternId, channelId: ChannelId): void {
  const pattern = d.patterns[patternId];
  const notes = current(d, patternId, channelId);
  if (!pattern || notes.length === 0) return;
  const byId = Object.fromEntries(notes.map((n) => [n.id, n])) as Record<NoteId, Note>;
  const steps = stepView(byId, pattern.stepCount).isSteps;
  const last = (pattern.stepCount - 1) * TICKS_PER_STEP;
  const len = cycle(d, patternId, notes);
  editNotes(
    d,
    patternId,
    channelId,
    notes.map((n) => ({ id: n.id, tick: steps ? last - n.tick : Math.max(0, len - n.tick - n.length) })),
  );
}

/**
 * Replaces the channel's notes with random steps: each step is on with probability `density`, at a
 * velocity between `minVelocity` and `maxVelocity`. `rand` returns numbers in [0, 1).
 */
export function randomizeSteps(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  opts: { rootKey: number; rand: () => number; density?: number; minVelocity?: number; maxVelocity?: number },
): void {
  const pattern = d.patterns[patternId];
  if (!pattern) return;
  clearSteps(d, patternId, channelId);
  const density = opts.density ?? 0.4;
  const lo = opts.minVelocity ?? 0.55;
  const hi = Math.max(lo, opts.maxVelocity ?? 1);
  const notes: Note[] = [];
  for (let s = 0; s < pattern.stepCount; s++) {
    const on = opts.rand() < density;
    const velocity = lo + opts.rand() * (hi - lo);
    if (on)
      notes.push({ id: newId.note(), tick: s * TICKS_PER_STEP, length: TICKS_PER_STEP, key: opts.rootKey, velocity });
  }
  addNotes(d, patternId, channelId, notes);
}
