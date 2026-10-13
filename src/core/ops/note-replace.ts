/**
 * Replacing a set of notes with a tool's result (note scripts, AI edits): which input notes are
 * edited, which are new and which are gone. Pure planning plus one draft mutator.
 */
import type { Draft } from 'immer';
import type { ChannelId, Note, NoteId, PatternId, Project } from '../model/types';
import { compactNote, removeNotes, sanitizeNote, writeNotes } from './notes';

/** A note as tools return it (structurally the SDK's `ScriptNote`): with the `id` of an input note to edit it, without one to add it. */
export interface NoteLike {
  readonly id?: string;
  tick: number;
  length: number;
  key: number;
  velocity: number;
  pan?: number;
  release?: number;
  fine?: number;
  muted?: boolean;
}

export interface NoteReplacement {
  /** Input notes the result leaves out. */
  remove: NoteId[];
  /** Every resulting note, complete and sanitized, in the result's order: edited inputs keep their id. */
  write: Note[];
  /** How many of `write` are new notes. */
  added: number;
}

/**
 * Plans the replacement of `inputs` by `outputs`. An output with the id of an input note edits it
 * (optional fields it leaves out keep the input's value; neutral values clear them); an output
 * without one, or repeating an id already used, or naming a note that isn't an input, is a new note
 * and gets `mint(i)` for the i-th new note. Inputs that no output names are removed.
 */
export function planNoteReplacement(
  inputs: readonly Note[],
  outputs: readonly NoteLike[],
  mint: (index: number) => NoteId,
): NoteReplacement {
  const byId = new Map<string, Note>(inputs.map((n) => [n.id, n]));
  const used = new Set<string>();
  const write: Note[] = [];
  let added = 0;
  for (const o of outputs) {
    const src = o.id !== undefined && !used.has(o.id) ? byId.get(o.id) : undefined;
    const base: Note = src
      ? {
          ...src,
          tick: o.tick,
          length: o.length,
          key: o.key,
          velocity: o.velocity,
        }
      : { id: mint(added++), tick: o.tick, length: o.length, key: o.key, velocity: o.velocity };
    if (src) used.add(src.id);
    if (o.pan !== undefined) base.pan = o.pan;
    if (o.release !== undefined) base.release = o.release;
    if (o.fine !== undefined) base.fine = o.fine;
    if (o.muted !== undefined) base.muted = o.muted;
    write.push(compactNote(sanitizeNote(base)));
  }
  const remove = inputs.filter((n) => !used.has(n.id)).map((n) => n.id);
  return { remove, write, added };
}

/**
 * Applies a replacement. The recipe is absolute: applied on top of an earlier replacement of the
 * same inputs (a live preview), it produces the same document as applied to the original, provided
 * `stale` lists the new-note ids that earlier replacement added and this one doesn't.
 */
export function applyNoteReplacement(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  plan: NoteReplacement,
  stale: readonly NoteId[] = [],
): void {
  if (plan.remove.length > 0 || stale.length > 0) removeNotes(d, patternId, channelId, [...plan.remove, ...stale]);
  if (plan.write.length > 0) writeNotes(d, patternId, channelId, plan.write);
}
