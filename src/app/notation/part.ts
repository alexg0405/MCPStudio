/**
 * Which part of a pattern the sheet shows, and the notes, lyrics and chords it is engraved from. A part is one pitched
 * channel, one drum channel, or "Drums": every drum channel of the pattern on one percussion staff (a kick channel plays
 * its root key, so each drum channel's notes are written as the General MIDI drum its role names).
 */
import { gmKeyOf } from '@core/notation/drums';
import { isDrumRole, type Role } from '@core/arrange/roles';
import { formatChord } from '@core/harmony/chord';
import type { ChannelId, Note, PatternId, Project } from '@core/model/types';
import type { EngraveInput, NotationChord, NotationLyric, NotationNote } from '@core/notation/types';
import { patternChords, projectUsesFlats } from '@core/query/chords';
import { patternLyrics } from '@core/query/lyrics';
import { patternLength } from '@core/query/queries';
import { rolesOf } from '../arrange/env';
import type { SheetViewState } from '../stores/editor';

/** The id of the part that is every drum channel together. */
export const DRUMS_PART = 'drums';
/** The id of the part that follows the piano roll's channel. */
export const AUTO_PART = 'auto';

/** One thing the part menu offers. */
export interface PartChoice {
  /** `DRUMS_PART` or a channel id. */
  id: string;
  label: string;
  isPercussion: boolean;
  noteCount: number;
}

/** What the sheet is engraved from, and where its edits go. */
export interface SheetPart {
  /** The channel whose notes the part is (null for the combined drums). */
  channelId: ChannelId | null;
  isPercussion: boolean;
  /** The part id as the menu names it. */
  id: string;
  label: string;
  notes: NotationNote[];
}

const countOf = (notes: Record<string, Note> | undefined): number => (notes ? Object.keys(notes).length : 0);

/** The channels of the pattern that have notes, as the choices of the part menu ("Drums" first when there are drum channels). */
export function listParts(project: Project, patternId: PatternId): PartChoice[] {
  const pattern = project.patterns[patternId];
  if (!pattern) return [];
  const roles = rolesOf(project);
  const choices: PartChoice[] = [];
  let drumNotes = 0;
  for (const channelId of project.channelOrder) {
    const channel = project.channels[channelId];
    const count = countOf(pattern.notes[channelId]);
    if (!channel || channel.kind !== 'instrument' || count === 0) continue;
    const isDrum = isDrumRole(roles.get(channelId) ?? 'other');
    if (isDrum) drumNotes += count;
    choices.push({ id: channelId, label: channel.name, isPercussion: isDrum, noteCount: count });
  }
  const drumChannels = choices.filter((choice) => choice.isPercussion);
  if (drumChannels.length > 1) choices.unshift({ id: DRUMS_PART, label: 'All drums', isPercussion: true, noteCount: drumNotes });
  return choices;
}

/**
 * Which part to show. 'auto' is the piano roll's channel when it has notes in the pattern, otherwise the first part there
 * is; a named part that has no notes any more falls back the same way.
 */
export function resolvePart(project: Project, patternId: PatternId, wanted: string, selectedChannelId: ChannelId | null): SheetPart | null {
  const choices = listParts(project, patternId);
  const pick =
    choices.find((choice) => choice.id === wanted) ??
    choices.find((choice) => choice.id === selectedChannelId) ??
    choices.find((choice) => !choice.isPercussion) ??
    choices[0];
  if (!pick) return null;
  const isPercussion = pick.isPercussion;
  const channelId = pick.id === DRUMS_PART ? null : (pick.id as ChannelId);
  return { channelId, isPercussion, id: pick.id, label: pick.label, notes: notesOfPart(project, patternId, channelId, isPercussion) };
}

function toNotationNote(note: Note, channelId: ChannelId, key: number): NotationNote {
  return { id: note.id, channelId, tick: note.tick, length: note.length, key, velocity: note.velocity };
}

/** The notes of a part, for the engraver. Muted notes are still written: the score is what was composed. */
function notesOfPart(project: Project, patternId: PatternId, channelId: ChannelId | null, isPercussion: boolean): NotationNote[] {
  const pattern = project.patterns[patternId];
  if (!pattern) return [];
  const roles = rolesOf(project);
  const channels = channelId ? [channelId] : project.channelOrder.filter((id) => isDrumRole(roles.get(id) ?? 'other'));
  const out: NotationNote[] = [];
  for (const id of channels) {
    const role: Role = roles.get(id) ?? 'other';
    for (const note of Object.values(pattern.notes[id] ?? {})) out.push(toNotationNote(note, id, isPercussion ? gmKeyOf(role, note.key) : note.key));
  }
  return out;
}

function lyricsOf(project: Project, patternId: PatternId): NotationLyric[] {
  return patternLyrics(project, patternId).map((entry) => ({
    tick: entry.tick,
    length: entry.length,
    text: entry.word.text,
    continues: !!entry.word.continues,
  }));
}

function chordsOf(project: Project, patternId: PatternId): NotationChord[] {
  const flats = projectUsesFlats(project);
  return patternChords(project, patternId).map((entry) => ({ tick: entry.tick, length: entry.length, text: formatChord(entry.chord, flats) }));
}

/** Everything the engraver reads for a part of a pattern. */
export function engraveInputFor(project: Project, patternId: PatternId, part: SheetPart, settings: SheetViewState): EngraveInput {
  const pattern = project.patterns[patternId];
  const timeSig = project.transport.timeSig;
  return {
    notes: part.notes,
    isPercussion: part.isPercussion,
    lengthTicks: pattern ? patternLength(pattern, timeSig) : 0,
    timeSig,
    ...(project.transport.key ? { key: project.transport.key } : {}),
    bpm: project.transport.bpm,
    grid: settings.grid,
    clef: settings.clef,
    dynamics: settings.dynamics,
    ...(settings.lyrics && !part.isPercussion ? { lyrics: lyricsOf(project, patternId) } : {}),
    ...(settings.chords ? { chords: chordsOf(project, patternId) } : {}),
  };
}
