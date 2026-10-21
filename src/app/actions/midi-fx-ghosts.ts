/**
 * The notes a channel's MIDI effects make of a pattern, for the piano roll to show faintly behind the notes written there: what
 * plays when the pattern plays on its own. They are read the way the transport reads them, so they match what is heard.
 */
import type { ChannelId, Note, PatternId, Pattern, Project } from '@core/model/types';
import { hasActiveMidiFx } from '@core/query/midi-fx';
import { planBake } from './midi-fx-bake';

interface Cached {
  inputs: readonly unknown[];
  notes: readonly Note[];
}

const cache = new WeakMap<Pattern, Map<ChannelId, Cached>>();
const NONE: readonly Note[] = [];

/** What the cache's result was made from: when any of these differ the notes are made again. */
function inputsOf(project: Project, pattern: Pattern, channelId: ChannelId): readonly unknown[] {
  return [
    pattern.notes[channelId],
    project.channels[channelId],
    project.transport.key,
    project.transport.swing,
    project.transport.bpm,
    project.transport.timeSig,
    project.chords,
    project.playlist,
  ];
}

/** The notes the channel's effects make of the pattern, sorted by tick (none when it has no effect that does anything). */
export function effectNotesOf(project: Project, patternId: PatternId, channelId: ChannelId): readonly Note[] {
  const pattern = project.patterns[patternId];
  if (!pattern || !hasActiveMidiFx(project.channels[channelId])) return NONE;
  let perChannel = cache.get(pattern);
  if (!perChannel) cache.set(pattern, (perChannel = new Map()));
  const inputs = inputsOf(project, pattern, channelId);
  const known = perChannel.get(channelId);
  if (known && known.inputs.every((value, i) => value === inputs[i])) return known.notes;
  const plan = planBake(project, channelId, patternId);
  const notes = [...(plan?.patterns.find((entry) => entry.patternId === patternId)?.notes ?? NONE)].sort((a, b) => a.tick - b.tick);
  perChannel.set(channelId, { inputs, notes });
  return notes;
}
