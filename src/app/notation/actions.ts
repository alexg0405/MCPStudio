/**
 * Editing from the sheet, and MusicXML in and out. Every edit goes through History like the piano roll's own (one undo
 * step, repeated key presses merged), on the notes underneath, so the piano roll shows the same change at once.
 */
import { newId } from '@core/model/ids';
import type { ChannelId, Note, NoteId, PatternId, Project } from '@core/model/types';
import { entryName, entryTicks, movedKey, type EntryDuration, type PitchMove } from '@core/notation/edit';
import { readMusicXml } from '@core/notation/musicxml-read';
import { scoreToMusicXml } from '@core/notation/musicxml';
import { XmlError } from '@core/notation/xml';
import { addNotes, editNotes, removeNotes, type NoteEdit } from '@core/ops/notes';
import { ceilToBars } from '@core/time/ppq';
import { downloadBytes, uploadFile } from '@platform/fs-access';
import { rolesOf } from '../arrange/env';
import type { Services } from '../services';
import { selectedSheetNotes, sheetState } from './sheet';

/** What an action did, as a sentence for a toast or a screen reader. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const NOTHING_TO_SHOW = 'There is no sheet music here: open a pattern that has notes.';
const NOTHING_SELECTED = 'No note is selected: click a note on the sheet first.';
const DRUM_EDIT = 'Drum hits do not move up or down on the sheet: each line is a different drum. Change the duration or delete, or edit the hits in the piano roll.';

/** Groups note ids by their channel (the combined drums part holds notes of several). */
function byChannel(notes: ReadonlyArray<{ id: NoteId; channelId: ChannelId }>): Map<ChannelId, NoteId[]> {
  const groups = new Map<ChannelId, NoteId[]>();
  for (const note of notes) groups.set(note.channelId, [...(groups.get(note.channelId) ?? []), note.id]);
  return groups;
}

const noteCountText = (count: number): string => (count === 1 ? '1 note' : `${count} notes`);

/** Moves the selected notes up or down a scale step, a semitone or an octave. */
export function moveSelectedNotes(s: Services, direction: 1 | -1, move: PitchMove): ActionResult {
  const state = sheetState(s);
  if (!state) return { ok: false, message: NOTHING_TO_SHOW };
  if (state.part.isPercussion) return { ok: false, message: DRUM_EDIT };
  const notes = selectedSheetNotes(s, state.part);
  if (notes.length === 0) return { ok: false, message: NOTHING_SELECTED };
  const songKey = s.doc.getState().project.transport.key;
  const edits = notes.map((note) => ({ note, key: movedKey(note.key, direction, move, songKey) }));
  if (edits.every((edit) => edit.key === edit.note.key)) return { ok: false, message: 'Those notes cannot go any further that way.' };
  const unit = move === 'scale' ? 'scale step' : move;
  s.history.transact(
    `Move ${noteCountText(notes.length)} ${direction > 0 ? 'up' : 'down'} a ${unit}`,
    (draft) => {
      for (const [channelId, ids] of byChannel(notes)) {
        const wanted: NoteEdit[] = ids.map((id) => ({ id, key: (edits.find((edit) => edit.note.id === id) as { key: number }).key }));
        editNotes(draft, state.patternId, channelId, wanted);
      }
    },
    { mergeKey: `sheet-move:${state.part.id}` },
  );
  return { ok: true, message: `Moved ${noteCountText(notes.length)} ${direction > 0 ? 'up' : 'down'} a ${unit}` };
}

/** Gives the selected notes this duration (their start stays). */
export function setSelectedDuration(s: Services, duration: EntryDuration): ActionResult {
  const state = sheetState(s);
  if (!state) return { ok: false, message: NOTHING_TO_SHOW };
  const notes = selectedSheetNotes(s, state.part);
  if (notes.length === 0) return { ok: false, message: NOTHING_SELECTED };
  const length = entryTicks(duration);
  s.history.transact(`Make ${noteCountText(notes.length)} a ${entryName(duration)}`, (draft) => {
    for (const [channelId, ids] of byChannel(notes)) editNotes(draft, state.patternId, channelId, ids.map((id) => ({ id, length })));
  });
  return { ok: true, message: `Made ${noteCountText(notes.length)} a ${entryName(duration)}` };
}

/** Deletes the selected notes. */
export function deleteSelectedNotes(s: Services): ActionResult {
  const state = sheetState(s);
  if (!state) return { ok: false, message: NOTHING_TO_SHOW };
  const notes = selectedSheetNotes(s, state.part);
  if (notes.length === 0) return { ok: false, message: NOTHING_SELECTED };
  s.history.transact(`Delete ${noteCountText(notes.length)}`, (draft) => {
    for (const [channelId, ids] of byChannel(notes)) removeNotes(draft, state.patternId, channelId, ids);
  });
  s.editor.getState().selectNotes([]);
  return { ok: true, message: `Deleted ${noteCountText(notes.length)}` };
}

/** The velocity a note typed on the sheet gets (about mezzo-forte, the piano roll's default). */
const ENTRY_VELOCITY = 100 / 128;

/** Puts a note at a pattern tick with the entry duration, in the part's channel, and selects it. */
export function insertNoteAt(s: Services, at: { tick: number; key: number }, duration: EntryDuration): ActionResult & { noteId?: NoteId } {
  const state = sheetState(s);
  if (!state) return { ok: false, message: NOTHING_TO_SHOW };
  const channelId = state.part.channelId;
  if (!channelId || state.part.isPercussion) return { ok: false, message: 'Notes are typed into a pitched part: pick an instrument part in the menu, not drums.' };
  const project = s.doc.getState().project;
  const pattern = project.patterns[state.patternId];
  const length = entryTicks(duration);
  const note: Note = { id: newId.note(), tick: Math.max(0, Math.round(at.tick)), length, key: Math.max(0, Math.min(127, at.key)), velocity: ENTRY_VELOCITY };
  if (pattern?.length !== undefined && note.tick >= pattern.length) return { ok: false, message: 'That is after the end of the pattern: make the pattern longer first.' };
  s.history.transact('Add note from the sheet', (draft) => {
    addNotes(draft, state.patternId, channelId, [note]);
    const target = draft.patterns[state.patternId];
    if (target?.length !== undefined && note.tick + length > target.length) target.length = ceilToBars(note.tick + length, project.transport.timeSig);
  });
  s.editor.getState().selectNotes([note.id]);
  return { ok: true, message: 'Added a note', noteId: note.id };
}

/** The title of a MusicXML file: the project and the pattern. */
function titleOf(project: Project, patternId: PatternId): string {
  const pattern = project.patterns[patternId];
  return [project.meta.title, pattern?.name].filter(Boolean).join(' - ') || 'AGstudio';
}

/** The MusicXML text of the sheet and the file name it should be saved as. */
export function musicXmlOfSheet(s: Services): { xml: string; name: string } | null {
  const state = sheetState(s);
  if (!state) return null;
  const project = s.doc.getState().project;
  const title = titleOf(project, state.patternId);
  const xml = scoreToMusicXml(state.score, { title, partName: state.part.label });
  return { xml, name: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Sheet music'}.musicxml` };
}

/** Saves the sheet as a MusicXML file (a download). */
export function exportMusicXml(s: Services): ActionResult {
  const file = musicXmlOfSheet(s);
  if (!file) return { ok: false, message: NOTHING_TO_SHOW };
  downloadBytes(file.name, new TextEncoder().encode(file.xml), 'application/vnd.recordare.musicxml+xml');
  return { ok: true, message: `Saved ${file.name}.` };
}

/** The browser's file chooser for MusicXML files (null when cancelled). */
export function pickMusicXmlFile(): Promise<File | null> {
  return uploadFile('.musicxml,.xml,application/vnd.recordare.musicxml+xml,text/xml');
}

/** What importing does with the notes the channel already has in the pattern. */
export interface ImportOptions {
  replace: boolean;
}

/** Reads a MusicXML file's first part into the piano roll's channel in the current pattern, as one undo step. */
export function importMusicXmlText(s: Services, text: string, options: ImportOptions): ActionResult {
  const project = s.doc.getState().project;
  const patternId = s.view.getState().currentPatternId;
  const channelId = s.session.getState().selectedChannelId;
  const channel = channelId ? project.channels[channelId] : undefined;
  if (!patternId || !project.patterns[patternId]) return { ok: false, message: 'Open a pattern first: the notes go into the current pattern.' };
  if (!channelId || channel?.kind !== 'instrument') return { ok: false, message: 'Select an instrument channel in the channel rack first: the notes go into that channel.' };
  let imported;
  try {
    imported = readMusicXml(text);
  } catch (error) {
    return { ok: false, message: error instanceof XmlError ? error.message : 'That file could not be read as MusicXML.' };
  }
  if (imported.notes.length === 0) return { ok: false, message: 'That file has no notes in its first part.' };
  if (imported.isPercussion && rolesOf(project).get(channelId) !== 'kit') {
    return { ok: false, message: 'That file is a drum part: select a Drum Pads or Drum Synth channel to import it into.' };
  }
  const notes: Note[] = imported.notes.map((note) => ({ id: newId.note(), tick: note.tick, length: note.length, key: note.key, velocity: 0.8 }));
  s.history.transact('Import MusicXML', (draft) => {
    const pattern = draft.patterns[patternId];
    if (!pattern) return;
    if (options.replace) delete pattern.notes[channelId];
    addNotes(draft, patternId, channelId, notes);
    const end = Math.max(...notes.map((note) => note.tick + note.length));
    if (pattern.length !== undefined && end > pattern.length) pattern.length = ceilToBars(end, project.transport.timeSig);
  });
  const timeSig = project.transport.timeSig;
  const warnings: string[] = [];
  if (imported.timeSig && (imported.timeSig.num !== timeSig.num || imported.timeSig.den !== timeSig.den)) {
    warnings.push(`the file is in ${imported.timeSig.num}/${imported.timeSig.den} and the song is in ${timeSig.num}/${timeSig.den}, so bars will not line up`);
  }
  if (imported.partCount > 1) warnings.push(`only the first of its ${imported.partCount} parts was read`);
  const tail = warnings.length > 0 ? ` (${warnings.join('; ')})` : '';
  return { ok: true, message: `Imported ${noteCountText(notes.length)} from "${imported.partName}"${tail}.` };
}
