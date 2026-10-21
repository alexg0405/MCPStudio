import { deleteSelectedNotes, exportMusicXml, moveSelectedNotes, setSelectedDuration, type ActionResult } from '@app/notation/actions';
import type { Services } from '@app/services';
import type { SheetViewState } from '@app/stores/editor';
import type { PitchMove } from '@core/notation/edit';
import { NOTATION_GRIDS, type ClefChoice, type NotationGrid } from '@core/notation/types';
import { addContextMenuItems } from '../../context-menus';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { printSheet } from './print';
import { importMusicXmlDialog } from './sheet-import';

/** Shows what an action did as a toast. */
function report(services: Services, result: ActionResult): void {
  services.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

const CLEFS: readonly ClefChoice[] = ['auto', 'treble', 'bass', 'grand'];
const DURATION_BASES = [1, 2, 4, 8, 16, 32] as const;

/** What `sheet.options` takes: any of the window's settings. */
interface OptionsArgs {
  part?: string;
  grid?: string;
  clef?: string;
  dynamics?: boolean;
  lyrics?: boolean;
  chords?: boolean;
  zoom?: number;
  follow?: boolean;
}

/** What `sheet.setDuration` takes. */
interface DurationArgs {
  base?: number;
  dotted?: boolean;
  triplet?: boolean;
}

/**
 * Sheet music: the current pattern as a score (clefs, key signature, ties, beams, triplets, two voices, drums, lyrics,
 * chord symbols), read-along while it plays, printed or saved as PDF, exported to and imported from MusicXML, and edited from
 * the page or the keyboard. Studio has the same through the `get_notation` read and the `write_notation` action.
 */
export function register(services: Services): void {
  registerSheetWindow(services);
  registerSheetCommands(services);
  registerSheetMenus();
  registerSheetHelp();
}

function registerSheetWindow(services: Services): void {
  registerWindowType({
    type: 'sheet-music',
    title: () => 'Sheet music',
    component: lazyWindow(() => import('./SheetMusicWindow'), (m) => m.SheetMusicWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 420)), y: 48, w: Math.min(840, ws.w), h: Math.min(600, ws.h - 70) }),
    minSize: { w: 420, h: 260 },
  });
  registerWindowToggle(services, {
    command: 'view.sheetMusic',
    type: 'sheet-music',
    title: 'Sheet music',
    hint: 'The current pattern as sheet music: read it, print it or save a PDF, export MusicXML, and edit notes from the page or the keyboard',
    chords: ['Alt+Shift+N'],
    menuOrder: 62,
  });
}

function registerSheetCommands({ commands }: Services): void {
  commands.register({
    id: 'sheet.print',
    gesture: true,
    title: 'Print sheet music…',
    category: 'Sheet music',
    hint: 'Open the print dialog with the sheet laid out for paper; choose Save as PDF there to make a PDF',
    run: (s) => report(s, printSheet(s)),
  });
  commands.register({
    id: 'sheet.exportMusicXml',
    gesture: true,
    title: 'Save sheet music as MusicXML…',
    category: 'Sheet music',
    hint: 'Save the shown part as a MusicXML file that MuseScore, Sibelius, Finale and Dorico open',
    run: (s) => report(s, exportMusicXml(s)),
  });
  commands.register({
    id: 'sheet.importMusicXml',
    gesture: true,
    title: 'Import MusicXML…',
    category: 'Sheet music',
    hint: 'Read the notes of a MusicXML file into the selected channel in the current pattern (one undo step)',
    run: (s) => importMusicXmlDialog(s),
  });
  commands.register<OptionsArgs>({
    id: 'sheet.options',
    title: 'Sheet music settings',
    category: 'Sheet music',
    hint: 'Choose the part shown, the smallest note value, the clef, whether dynamics, lyrics and chord symbols show, the zoom and following the song',
    argsHint:
      '{ part: "auto" | "drums" | a channel id, grid: "1/8" | "1/16" | "1/32", clef: "auto" | "treble" | "bass" | "grand", dynamics, lyrics, chords, follow (booleans), zoom (50-200 percent) }',
    run: (s, args) => {
      const patch: Partial<SheetViewState> = {};
      if (args?.part !== undefined) patch.part = args.part;
      if (args?.grid !== undefined && (NOTATION_GRIDS as readonly string[]).includes(args.grid)) patch.grid = args.grid as NotationGrid;
      if (args?.clef !== undefined && (CLEFS as readonly string[]).includes(args.clef)) patch.clef = args.clef as ClefChoice;
      if (args?.dynamics !== undefined) patch.dynamics = !!args.dynamics;
      if (args?.lyrics !== undefined) patch.lyrics = !!args.lyrics;
      if (args?.chords !== undefined) patch.chords = !!args.chords;
      if (args?.follow !== undefined) patch.follow = !!args.follow;
      if (args?.zoom !== undefined && Number.isFinite(args.zoom)) patch.zoom = Math.max(50, Math.min(200, Math.round(args.zoom)));
      s.editor.getState().setSheet(patch);
    },
  });
  commands.register<{ direction?: string; by?: string }>({
    id: 'sheet.movePitch',
    title: 'Move selected notes up or down on the sheet',
    category: 'Sheet music',
    hint: 'Raise or lower the selected notes a step of the song key’s scale, a semitone or an octave (one undo step)',
    argsHint: '{ direction: "up" | "down", by: "scale" (default) | "semitone" | "octave" }; acts on the selected notes',
    run: (s, args) => {
      const by: PitchMove = args?.by === 'semitone' || args?.by === 'octave' ? args.by : 'scale';
      report(s, moveSelectedNotes(s, args?.direction === 'down' ? -1 : 1, by));
    },
  });
  commands.register<DurationArgs>({
    id: 'sheet.setDuration',
    title: 'Set the note length on the sheet',
    category: 'Sheet music',
    hint: 'Choose how long typed notes are, and give the selected notes that length (whole to thirty-second, dotted or triplet)',
    argsHint: '{ base: 1 | 2 | 4 | 8 | 16 | 32 (the note value: 4 is a quarter note), dotted, triplet (booleans) }',
    run: (s, args) => {
      const base = DURATION_BASES.find((value) => value === args?.base);
      if (!base) {
        s.session.getState().toast('Choose a note value: 1, 2, 4, 8, 16 or 32.', 'error');
        return;
      }
      const entry = { base, isDotted: args?.dotted === true, isTriplet: args?.triplet === true && args?.dotted !== true };
      s.editor.getState().setSheet({ entry });
      if (s.editor.getState().noteSelection.length > 0) report(s, setSelectedDuration(s, entry));
    },
  });
  commands.register({
    id: 'sheet.deleteNotes',
    title: 'Delete the selected notes (from the sheet)',
    category: 'Sheet music',
    hint: 'Remove the selected notes from the pattern (one undo step)',
    run: (s) => report(s, deleteSelectedNotes(s)),
  });
}

function registerSheetMenus(): void {
  addMenuItems('file', [sep(79), cmd('sheet.print', 79.1), cmd('sheet.exportMusicXml', 79.2), cmd('sheet.importMusicXml', 79.3)]);
  addContextMenuItems('pianoRoll.empty', (_ctx, s) => [
    { kind: 'label', label: 'Sheet music' },
    { label: 'Show as sheet music', hint: 'Open this pattern as a score you can read, print and edit', onSelect: () => void openWindow(s, 'sheet-music') },
  ]);
  addActionProvider('sheet-music', (s) => [
    {
      key: 'sheet.open',
      label: 'Sheet music: read, print and edit the pattern as notation',
      path: ['View', 'Sheet music'],
      hint: 'The current pattern as a score with clefs, key signature, ties, triplets and drums; print it or save a PDF, export or import MusicXML',
      keywords: ['sheet', 'music', 'notation', 'score', 'staff', 'notes', 'print', 'pdf', 'musicxml', 'engrave', 'read', 'treble', 'bass', 'clef'],
      run: () => openWindow(s, 'sheet-music'),
    },
  ]);
}

function registerSheetHelp(): void {
  setWindowHelp('sheet-music', {
    intro: 'The current pattern written as sheet music: clefs, the song key’s signature, bars, ties, beams, triplets, two voices, drums, lyrics and chord symbols. Middle C is written C4 here (the piano roll calls it C5).',
    moves: [
      ['Choose a part', 'The Part menu shows one instrument at a time, or all the drums on one line (kick low, snare in the middle, hi-hat above)'],
      ['Click a note', 'It is selected here and in the piano roll. Shift or Ctrl/Cmd + click adds more; click empty space to clear and to put the cursor there'],
      ['Move and change notes', 'Up and Down arrows move the selected notes a scale step (Shift: a semitone, Ctrl/Cmd: an octave); keys 1 2 4 8 6 3 change their length; Delete removes them. Each is one undo step and the piano roll changes too'],
      ['Type notes', 'Tab into the page, then press A to G: the note goes at the cursor as long as the Typing length and the cursor moves on (Shift makes a sharp, Alt a flat, R leaves a rest). Left and Right move the cursor'],
      ['Follow', 'While the song plays the notes being played light up and the page turns to keep them in view'],
      ['Print or PDF', 'Print… opens the browser’s print dialog with the sheet laid out for paper; choose Save as PDF there'],
      ['MusicXML', 'Save MusicXML writes a file for MuseScore, Sibelius, Finale and Dorico; Import MusicXML… reads the first part of such a file into the selected channel'],
      ['Studio', 'Ask “write this melody as | C4q E4q G4h |” or “show me the bass line as sheet music”: Studio reads and writes patterns in the same short notation'],
    ],
  });
}
