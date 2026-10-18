/**
 * Turns what the musician has selected into the focus of an AI request: playlist clips, the loop
 * region (a marker section when it matches one exactly), a marker's section, or piano-roll notes.
 * The focus is captured when the musician asks, so later selection changes don't move it.
 */
import type { ChannelId, ClipId, MarkerId, NoteId, PatternId } from '@core/model/types';
import { sectionMatching, songSections } from '@core/query/sections';
import type { Services } from '../services';
import type { AiFocus } from './focus';

/** A marker's section (from the marker to the next one, the last to the song's end). */
export function focusFromMarker(services: Services, markerId: MarkerId): AiFocus | null {
  const project = services.doc.getState().project;
  const section = songSections(project).find((x) => x.markerId === markerId);
  if (!section) return null;
  return { kind: 'section', markerId, from: section.from, to: section.to, projectId: project.projectId };
}

/** Some playlist clips (the ones that exist). */
export function focusFromClips(services: Services, clipIds: readonly ClipId[]): AiFocus | null {
  const project = services.doc.getState().project;
  const ids = [...new Set(clipIds)].filter((id) => project.playlist.clips[id]);
  return ids.length ? { kind: 'clips', clipIds: ids, projectId: project.projectId } : null;
}

/** A span of the song: the section it matches exactly, else a range. */
export function focusFromRange(services: Services, from: number, to: number): AiFocus | null {
  const project = services.doc.getState().project;
  const a = Math.max(0, Math.round(Math.min(from, to)));
  const b = Math.round(Math.max(from, to));
  if (b <= a) return null;
  const section = sectionMatching(project, a, b);
  return section
    ? { kind: 'section', markerId: section.markerId, from: a, to: b, projectId: project.projectId }
    : { kind: 'range', from: a, to: b, projectId: project.projectId };
}

/** The playlist's selection: the selected clips, else the loop region; null when neither is set. */
export function focusFromPlaylist(services: Services): AiFocus | null {
  const fromClips = focusFromClips(services, services.editor.getState().clipSelection);
  if (fromClips) return fromClips;
  const loop = services.view.getState().loop;
  return loop ? focusFromRange(services, loop.start, loop.end) : null;
}

/**
 * Notes of one channel in a pattern: the ones given, else the piano roll's (the selected channel in
 * the current pattern: its selected notes, or all of them when none is selected).
 */
export function focusFromNotes(
  services: Services,
  at?: { patternId: PatternId; channelId: ChannelId; noteIds?: readonly NoteId[] },
): AiFocus | null {
  const project = services.doc.getState().project;
  const patternId = at?.patternId ?? services.view.getState().currentPatternId;
  const channelId = at?.channelId ?? services.session.getState().selectedChannelId;
  const pattern = patternId ? project.patterns[patternId] : undefined;
  const channel = channelId ? project.channels[channelId] : undefined;
  if (!patternId || !channelId || !pattern || channel?.kind !== 'instrument') return null;
  const notes = pattern.notes[channelId] ?? {};
  const wanted = at?.noteIds ?? services.editor.getState().noteSelection;
  let ids = wanted.filter((id) => notes[id]);
  if (ids.length === 0) ids = Object.keys(notes) as NoteId[];
  if (ids.length === 0) return null;
  return { kind: 'notes', patternId, channelId, noteIds: [...new Set(ids)], projectId: project.projectId };
}
