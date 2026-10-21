/**
 * The sheet as the app sees it: which pattern and part are shown, the engraved score, and the notes the selection points
 * at. The window, the commands and the AI reads all start here, so they agree about what "the sheet" is.
 */
import type { NoteId, PatternId } from '@core/model/types';
import { engrave } from '@core/notation/engrave';
import type { NotationNote, Score } from '@core/notation/types';
import { engraveInputFor, resolvePart, type SheetPart } from './part';
import type { Services } from '../services';

/** The pattern, part and score on the sheet right now. */
export interface SheetState {
  patternId: PatternId;
  part: SheetPart;
  score: Score;
}

/** Engraves a part of a pattern with the editor's sheet settings; null when the pattern has no notes to show. */
export function sheetState(s: Services, patternId: PatternId | null = s.view.getState().currentPatternId): SheetState | null {
  if (!patternId) return null;
  const project = s.doc.getState().project;
  const settings = s.editor.getState().sheet;
  const part = resolvePart(project, patternId, settings.part, s.session.getState().selectedChannelId);
  if (!part) return null;
  return { patternId, part, score: engrave(engraveInputFor(project, patternId, part, settings)) };
}

/** The notes of the part that the selection (shared with the piano roll) holds. */
export function selectedSheetNotes(s: Services, part: SheetPart): NotationNote[] {
  const selected = new Set<NoteId>(s.editor.getState().noteSelection);
  return part.notes.filter((note) => selected.has(note.id));
}
