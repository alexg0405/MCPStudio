/** The right-click menu of the sheet: what can be done to the selected notes, and the file actions. */
import { deleteSelectedNotes, exportMusicXml, moveSelectedNotes, setSelectedDuration, type ActionResult } from '@app/notation/actions';
import type { Services } from '@app/services';
import type { EntryDuration, PitchMove } from '@core/notation/edit';
import type { MenuEntry } from '../../controls/ContextMenu';
import { printSheet } from './print';

const DURATIONS: ReadonlyArray<{ label: string; duration: EntryDuration }> = [
  { label: 'Whole note', duration: { base: 1, isDotted: false, isTriplet: false } },
  { label: 'Half note', duration: { base: 2, isDotted: false, isTriplet: false } },
  { label: 'Quarter note', duration: { base: 4, isDotted: false, isTriplet: false } },
  { label: 'Eighth note', duration: { base: 8, isDotted: false, isTriplet: false } },
  { label: 'Sixteenth note', duration: { base: 16, isDotted: false, isTriplet: false } },
  { label: 'Thirty-second note', duration: { base: 32, isDotted: false, isTriplet: false } },
  { label: 'Dotted quarter', duration: { base: 4, isDotted: true, isTriplet: false } },
  { label: 'Dotted eighth', duration: { base: 8, isDotted: true, isTriplet: false } },
  { label: 'Eighth triplet', duration: { base: 8, isDotted: false, isTriplet: true } },
];

/** Shows what an action did as a toast. */
export function report(s: Services, result: ActionResult): void {
  s.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

function mover(s: Services, label: string, direction: 1 | -1, move: PitchMove, hint: string): MenuEntry {
  return { label, hint, onSelect: () => report(s, moveSelectedNotes(s, direction, move)) };
}

/** The menu for a right-click on the sheet; `hasSelection` greys out what needs a selected note. */
export function sheetMenu(s: Services): MenuEntry[] {
  const hasSelection = s.editor.getState().noteSelection.length > 0;
  const needs = (entry: MenuEntry): MenuEntry => (entry.kind === 'item' || entry.kind === undefined ? { ...entry, disabled: !hasSelection } : entry);
  return [
    { kind: 'label', label: 'Sheet music' },
    needs(mover(s, 'Raise a scale step', 1, 'scale', 'Move the selected notes up to the next note of the song key (Up arrow)')),
    needs(mover(s, 'Lower a scale step', -1, 'scale', 'Move the selected notes down to the next note of the song key (Down arrow)')),
    needs(mover(s, 'Raise a semitone', 1, 'semitone', 'Move the selected notes up one half step (Shift + Up)')),
    needs(mover(s, 'Lower a semitone', -1, 'semitone', 'Move the selected notes down one half step (Shift + Down)')),
    needs(mover(s, 'Raise an octave', 1, 'octave', 'Move the selected notes up twelve half steps (Ctrl or Cmd + Up)')),
    needs(mover(s, 'Lower an octave', -1, 'octave', 'Move the selected notes down twelve half steps (Ctrl or Cmd + Down)')),
    {
      kind: 'submenu',
      label: 'Duration',
      hint: 'Change how long the selected notes are (keys 1 2 4 8 6 3; . for dotted, T for triplet)',
      disabled: !hasSelection,
      items: DURATIONS.map((entry) => ({ label: entry.label, onSelect: () => report(s, setSelectedDuration(s, entry.duration)) })),
    },
    needs({ label: 'Delete', danger: true, shortcut: 'Del', hint: 'Remove the selected notes', onSelect: () => report(s, deleteSelectedNotes(s)) }),
    { kind: 'separator' },
    { label: 'Print or save as PDF…', hint: 'Open the print dialog with this sheet laid out for paper', onSelect: () => report(s, printSheet(s)) },
    { label: 'Save as MusicXML…', hint: 'Save this part as a MusicXML file for other notation programs', onSelect: () => report(s, exportMusicXml(s)) },
  ];
}
