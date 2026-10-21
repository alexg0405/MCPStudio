/**
 * "Render MIDI effects to notes": writes what a channel's effects make into its patterns as ordinary notes, so the part plays
 * the same without the effects (and can be edited by hand). It reads the notes the way the transport plays a pattern on its own
 * (`collectNotes` in pattern mode: the same code that plays them), so what is written is what was heard, to the tick.
 */
import type { Draft } from 'immer';
import { newId } from '@core/model/ids';
import type { ChannelId, MidiFxSlot, Note, NoteId, PatternId, Project } from '@core/model/types';
import { clearMidiFx, setMidiFxEnabled } from '@core/ops/midi-fx';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import { patternLength } from '@core/query/queries';
import { collectNotes, patternModeSource, type NoteEvent } from '@engine/sched/events';

/** The most notes a bake may write (the same limit a note script has). */
export const MAX_BAKED_NOTES = 50_000;

/** What baking one channel would write: the new notes of each pattern that has notes for the channel. */
export interface BakePlan {
  patterns: { patternId: PatternId; name: string; notes: Note[] }[];
  /** The notes the channel's patterns hold now. */
  before: number;
  /** The notes they would hold after. */
  after: number;
}

/** The patterns where the channel has notes (the ones its effects change). */
function patternsWithNotes(project: Project, channelId: ChannelId): PatternId[] {
  return project.patternOrder.filter((id) => Object.keys(project.patterns[id]?.notes[channelId] ?? {}).length > 0);
}

/** A note of the pattern for an event the transport would send (positions are whole ticks; the swing stays the project's to add). */
function noteOf(event: NoteEvent, patternTicks: number): Note {
  const tick = Math.min(patternTicks - 1, Math.max(0, Math.round(event.rawStart)));
  const note: Note = {
    id: newId.note() as NoteId,
    tick,
    length: Math.max(1, Math.min(patternTicks - tick, Math.round(event.end - event.start))),
    key: event.pitch,
    velocity: event.velocity,
  };
  if (event.pan !== undefined) note.pan = event.pan;
  if (event.fine !== undefined) note.fine = event.fine;
  if (event.release !== undefined) note.release = event.release;
  return note;
}

/**
 * What the channel's effects make of each of its patterns, as notes. Null when the channel has no effect that does anything.
 * `only` limits it to one pattern. (The notes get new ids each time: call it once per edit.)
 */
export function planBake(project: Project, channelId: ChannelId, only?: PatternId): BakePlan | null {
  if (!hasActiveMidiFx(project.channels[channelId])) return null;
  const audible = withEveryChannelAudible(project);
  const plan: BakePlan = { patterns: [], before: 0, after: 0 };
  for (const patternId of patternsWithNotes(project, channelId)) {
    if (only !== undefined && patternId !== only) continue;
    const pattern = project.patterns[patternId];
    if (!pattern) continue;
    const length = patternLength(pattern, project.transport.timeSig);
    const events: NoteEvent[] = [];
    collectNotes(patternModeSource(audible, patternId).source, 0, length, events);
    const notes = events.filter((event) => event.channelId === channelId).map((event) => noteOf(event, length));
    plan.before += Object.keys(pattern.notes[channelId] ?? {}).length;
    plan.after += notes.length;
    plan.patterns.push({ patternId, name: pattern.name, notes });
  }
  return plan;
}

/**
 * Writes a bake into a draft: every planned pattern gets the planned notes in place of the channel's own, and the effects are
 * taken out (or only bypassed, with `keepEffects`) because what they make is in the notes now.
 */
export function writeBake(draft: Draft<Project>, channelId: ChannelId, plan: BakePlan, options: { keepEffects?: boolean } = {}): void {
  for (const { patternId, notes } of plan.patterns) {
    const written: Record<string, Note> = {};
    for (const note of notes) written[note.id] = note;
    draft.patterns[patternId]!.notes[channelId] = written as never;
  }
  if (!options.keepEffects) {
    clearMidiFx(draft, channelId);
    return;
  }
  for (const slot of midiFxOf(draft.channels[channelId]) as readonly MidiFxSlot[]) setMidiFxEnabled(draft, channelId, slot.id, false);
}

/** The project with no channel muted or soloed: a muted channel plays nothing, but its notes are still what gets baked. */
function withEveryChannelAudible(project: Project): Project {
  const channels = Object.fromEntries(Object.entries(project.channels).map(([id, channel]) => [id, { ...channel, muted: false, solo: false }]));
  return { ...project, channels } as Project;
}

/** How many effects the channel's chain has (for messages). */
export const effectCount = (project: Project, channelId: ChannelId): number => midiFxOf(project.channels[channelId]).length;
