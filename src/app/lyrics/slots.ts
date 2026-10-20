/**
 * Where lyrics can be sung: the places (slots, song ticks) that notes give them. From the notes the piano roll has
 * selected, from a channel's notes as the song plays them, or from the notes a singer sang in an audio clip (the pitch
 * analysis the Pitch editor uses).
 */
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode } from '@core/audio/playback';
import { playedNotes } from '@core/arrange/notes';
import { slotsFromNotes, slotsFromSungNotes, type Slot, type SlotNote } from '@core/lyrics/slots';
import type { ChannelId, ClipId, Note, PatternId, Project, Tick } from '@core/model/types';
import { patternToSongShift } from '@core/query/lyrics';
import { audioClipOf, analyzeClip, editFor, pitchEditOf } from '../actions/pitch';
import type { Services } from '../services';

/**
 * The slots of the notes selected in the piano roll (the selected channel's notes in the current pattern), at the place
 * the pattern first plays in the song; with nothing selected, all of that channel's notes in the pattern. Null when there
 * is no such channel or pattern, or it has no notes.
 */
export function pianoRollSlots(s: Services): { slots: Slot[]; isSelection: boolean } | null {
  const project = s.doc.getState().project;
  const channelId = s.session.getState().selectedChannelId;
  const patternId = s.view.getState().currentPatternId;
  const pattern = patternId ? project.patterns[patternId] : undefined;
  if (!channelId || !patternId || !pattern) return null;
  const notes = Object.values(pattern.notes[channelId] ?? {}) as Note[];
  const selected = new Set(s.editor.getState().noteSelection);
  const chosen = notes.filter((note) => !note.muted && selected.has(note.id));
  const isSelection = chosen.length > 0;
  const slots = slotsOfPatternNotes(project, patternId, isSelection ? chosen : notes.filter((note) => !note.muted));
  return slots.length > 0 ? { slots, isSelection } : null;
}

/** Slots of pattern notes, moved to where the pattern first plays in the song. */
export function slotsOfPatternNotes(project: Project, patternId: PatternId, notes: readonly Note[]): Slot[] {
  const shift = patternToSongShift(project, patternId);
  const placed: SlotNote[] = notes.map((note) => ({ tick: note.tick + shift, length: note.length, key: note.key }));
  return slotsFromNotes(placed);
}

/** The slots of one channel's notes as the song plays them from `fromTick` (before `toTick` when given). */
export function channelSongSlots(project: Project, channelId: ChannelId, fromTick: Tick, toTick: Tick = Infinity): Slot[] {
  const played = playedNotes(project, fromTick, toTick).filter((note) => note.channelId === channelId);
  return slotsFromNotes(played.map((note) => ({ tick: note.tick, length: note.length, key: note.key })));
}

/** The slots of an audio clip's sung notes from the clip's pitch edit or the analysis at hand (null when it has none yet). */
export function clipSungSlotsNow(project: Project, clipId: ClipId): Slot[] | null {
  const found = audioClipOf(project, clipId);
  const edit = pitchEditOf(project, clipId);
  if (!found || !edit) return null;
  const tempo = tempoMapOf(project, 'song');
  return slotsFromSungNotes(found.clip, playbackMode(found.channel), tempo, edit.notes.map((note) => ({ from: note.from, to: note.to, pitch: note.pitch })));
}

/** As `clipSungSlotsNow`, listening to the clip first when it has not been analysed (takes a moment for a long clip). */
export async function clipSungSlots(s: Services, clipId: ClipId): Promise<Slot[]> {
  const known = clipSungSlotsNow(s.doc.getState().project, clipId);
  if (known) return known;
  const analysis = await analyzeClip(s, clipId);
  const project = s.doc.getState().project;
  const found = audioClipOf(project, clipId);
  if (!found) return [];
  const edit = editFor(project, analysis);
  const tempo = tempoMapOf(project, 'song');
  return slotsFromSungNotes(found.clip, playbackMode(found.channel), tempo, edit.notes.map((note) => ({ from: note.from, to: note.to, pitch: note.pitch })));
}
