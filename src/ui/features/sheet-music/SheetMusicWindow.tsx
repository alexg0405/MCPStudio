import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { deleteSelectedNotes, exportMusicXml, moveSelectedNotes } from '@app/notation/actions';
import { listParts, resolvePart } from '@app/notation/part';
import type { SheetEntryDuration } from '@app/stores/editor';
import type { ChannelId, NoteId } from '@core/model/types';
import { entryName } from '@core/notation/edit';
import { keySignatureOf } from '@core/notation/spelling';
import { NOTATION_GRIDS, type ClefChoice, type NotationGrid } from '@core/notation/types';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices, useSession, useView } from '../../services-context';
import { KeyStack } from '../../timeline/key-cursor/stack';
import type { WindowContentProps } from '../../workspace/registry';
import { printSheet } from './print';
import { SheetController } from './sheet-controller';
import { importMusicXmlDialog } from './sheet-import';
import { handleSheetKey, summaryOf } from './sheet-keys';
import { report, sheetMenu } from './sheet-menu';
import './sheet-music.css';
import styles from './SheetMusic.module.css';

const ZOOM_STEP = 10;
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;

const CLEFS: ReadonlyArray<{ value: ClefChoice; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'treble', label: 'Treble' },
  { value: 'bass', label: 'Bass' },
  { value: 'grand', label: 'Both (piano)' },
];

const GRID_LABELS: Record<NotationGrid, string> = { '1/8': 'Eighth note (1/8)', '1/16': 'Sixteenth note (1/16)', '1/32': 'Thirty-second note (1/32)' };

const DURATION_OPTIONS: ReadonlyArray<{ base: SheetEntryDuration['base']; label: string; key: string }> = [
  { base: 1, label: 'Whole note', key: '1' },
  { base: 2, label: 'Half note', key: '2' },
  { base: 4, label: 'Quarter note', key: '4' },
  { base: 8, label: 'Eighth note', key: '8' },
  { base: 16, label: 'Sixteenth note', key: '6' },
  { base: 32, label: 'Thirty-second note', key: '3' },
];

/** What the window says while the pattern has no notes. */
function EmptyState() {
  return (
    <div className={styles.empty}>
      <p>
        <strong>No notes to show yet.</strong> Draw notes in the piano roll or the channel rack and they appear here as sheet
        music. This window then reads, prints and edits the pattern: click a note to select it (the piano roll selects it too),
        press the Up and Down arrows to move it a scale step, or Tab into the page and type note letters A to G.
      </p>
    </div>
  );
}

/** The Sheet music window: the current pattern as a score you can read, print, export and edit. */
export function SheetMusicWindow(_props: WindowContentProps) {
  const services = useServices();
  const settings = useStore(services.editor, (s) => s.sheet);
  const patternId = useView((s) => s.currentPatternId);
  const selectedChannel = useSession((s) => s.selectedChannelId);
  const pattern = useDoc((p) => (patternId ? p.patterns[patternId] : undefined));
  const channels = useDoc((p) => p.channels);
  const songKey = useDoc((p) => p.transport.key);
  const timeSig = useDoc((p) => p.transport.timeSig);
  const selectedCount = useStore(services.editor, (s) => s.noteSelection.length);
  const parts = useMemo(
    () => (patternId ? listParts(services.doc.getState().project, patternId) : []),
    // The pattern and the channels decide the list; the project object changes with every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, patternId, pattern, channels],
  );
  const shown = useMemo(
    () => (patternId ? resolvePart(services.doc.getState().project, patternId, settings.part, selectedChannel) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, patternId, pattern, channels, settings.part, selectedChannel],
  );
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const set = services.editor.getState().setSheet;

  useEffect(() => {
    if (!host.current || !content.current) return;
    const hostElement = host.current;
    const contentElement = content.current;
    const controller = new SheetController(services, hostElement, contentElement);
    const stack = new KeyStack(services, hostElement, {
      label: 'Sheet music',
      help: 'Left and Right move between notes, A to G type notes, 1 2 4 8 6 3 pick the duration, Up and Down move the selected notes, Delete removes them, question mark says where you are.',
      onKeyDown: (event) => handleSheetKey(services, controller, event, (text) => stack.say(text)),
      onActiveChange: (isActive) => controller.setCursorShown(isActive),
    });
    controller.onChange = () => stack.setSummary(controller.score ? summaryOf(services, controller) : 'There are no notes to show.');
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const head = event.target.closest<HTMLElement>('.ag-head');
      const editor = services.editor.getState();
      if (head?.dataset.note) {
        const id = head.dataset.note as NoteId;
        const isAdding = event.shiftKey || event.ctrlKey || event.metaKey;
        const selected = editor.noteSelection;
        if (isAdding) editor.selectNotes(selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id]);
        else if (!selected.includes(id)) editor.selectNotes([id]);
        const stop = controller.stops.find((candidate) => candidate.noteIds.includes(id));
        if (stop) controller.setCursor(stop.tick, stop.item.kind === 'chord' ? Math.max(...stop.item.heads.map((candidate) => candidate.key)) : undefined);
        return;
      }
      const svg = event.target.closest<SVGElement>('svg.ag-system');
      if (!svg) return;
      const zoom = services.editor.getState().sheet.zoom / 100;
      const tick = controller.tickAtX(Number(svg.dataset.system), (event.clientX - svg.getBoundingClientRect().left) / zoom);
      if (tick !== null) controller.setCursor(tick);
      if (!event.shiftKey) editor.selectNotes([]);
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const head = event.target instanceof Element ? event.target.closest<HTMLElement>('.ag-head') : null;
      const id = head?.dataset.note as NoteId | undefined;
      const editor = services.editor.getState();
      if (id && !editor.noteSelection.includes(id)) editor.selectNotes([id]);
      showContextMenu(event, sheetMenu(services));
    };
    contentElement.addEventListener('pointerdown', onPointerDown);
    contentElement.addEventListener('contextmenu', onContextMenu);
    controller.mount();
    return () => {
      contentElement.removeEventListener('pointerdown', onPointerDown);
      contentElement.removeEventListener('contextmenu', onContextMenu);
      controller.unmount();
      stack.dispose();
    };
  }, [services]);

  const hasParts = parts.length > 0;
  const entry = settings.entry;
  const signature = keySignatureOf(songKey);
  const partValue = settings.part === 'drums' ? 'drums' : (shown?.id ?? 'auto');
  const choosePart = (value: string) => {
    if (value === 'drums') {
      set({ part: 'drums' });
      return;
    }
    if (value !== 'auto') services.session.getState().selectChannel(value as ChannelId);
    set({ part: 'auto' });
  };
  const setZoom = (zoom: number) => set({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) });
  return (
    <div className={`${styles.root} ag-sheet`}>
      <div className={styles.bar} role="toolbar" aria-label="Sheet music tools" data-roving="horizontal">
        <label className={styles.field} data-hint="Which part is shown: one instrument or the drums. Choosing one also selects it in the piano roll">
          Part
          <select value={partValue} onChange={(e) => choosePart(e.target.value)} disabled={!hasParts}>
            {parts.map((part) => (
              <option key={part.id} value={part.id}>
                {part.label}
              </option>
            ))}
            {!hasParts && <option value="auto">No notes</option>}
          </select>
        </label>
        <label className={styles.field} data-hint="Smallest note value the score rounds to. Triplets are found on their own">
          Round to
          <select value={settings.grid} onChange={(e) => set({ grid: e.target.value as NotationGrid })}>
            {NOTATION_GRIDS.map((grid) => (
              <option key={grid} value={grid}>
                {GRID_LABELS[grid]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="Clef: automatic picks treble, bass or both from the range of the notes">
          Clef
          <select value={settings.clef} onChange={(e) => set({ clef: e.target.value as ClefChoice })} disabled={shown?.isPercussion}>
            {CLEFS.map((clef) => (
              <option key={clef.value} value={clef.value}>
                {clef.label}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.group} role="group" aria-label="What to show">
          <button className={`${styles.button} ${settings.dynamics ? styles.on : ''}`} aria-pressed={settings.dynamics} onClick={() => set({ dynamics: !settings.dynamics })} data-hint="Dynamics: write pp, p, mp, mf, f or ff under the notes where the velocity changes">
            Dynamics
          </button>
          <button className={`${styles.button} ${settings.lyrics ? styles.on : ''}`} aria-pressed={settings.lyrics} onClick={() => set({ lyrics: !settings.lyrics })} data-hint="Lyrics: write the project’s lyrics under the notes they start on">
            Lyrics
          </button>
          <button className={`${styles.button} ${settings.chords ? styles.on : ''}`} aria-pressed={settings.chords} onClick={() => set({ chords: !settings.chords })} data-hint="Chord symbols: write the chord track’s chords above the staff">
            Chords
          </button>
        </span>
        <span className={styles.group} role="group" aria-label="Zoom">
          <button className={styles.button} onClick={() => setZoom(settings.zoom - ZOOM_STEP)} aria-label="Zoom out" data-hint="Smaller notation (the page fits more bars on a line)">
            −
          </button>
          <span className={styles.zoomLabel} aria-live="off">
            {settings.zoom}%
          </span>
          <button className={styles.button} onClick={() => setZoom(settings.zoom + ZOOM_STEP)} aria-label="Zoom in" data-hint="Bigger notation">
            +
          </button>
        </span>
        <button className={`${styles.button} ${settings.follow ? styles.on : ''}`} aria-pressed={settings.follow} onClick={() => set({ follow: !settings.follow })} data-hint="Follow: the notes being played light up, and the page turns to keep them in view">
          Follow
        </button>
        <span className={styles.spacer} />
        <span className={styles.group} role="group" aria-label="Edit the selected notes">
          <button className={styles.button} disabled={selectedCount === 0} onClick={() => report(services, moveSelectedNotes(services, 1, 'scale'))} data-hint="Raise the selected notes one step of the song key's scale (Up arrow; Shift: a semitone; Ctrl or Cmd: an octave)">
            Raise
          </button>
          <button className={styles.button} disabled={selectedCount === 0} onClick={() => report(services, moveSelectedNotes(services, -1, 'scale'))} data-hint="Lower the selected notes one step of the song key's scale (Down arrow)">
            Lower
          </button>
          <button className={styles.button} disabled={selectedCount === 0} onClick={() => report(services, deleteSelectedNotes(services))} data-hint="Delete the selected notes (Delete key)">
            Delete
          </button>
        </span>
        <label className={styles.field} data-hint="How long the notes you type with the letter keys are (keys 1 2 4 8 6 3 pick it, . dots it, T makes triplets). It also changes the selected notes">
          Typing
          <select value={entry.base} onChange={(e) => services.commands.run('sheet.setDuration', { base: Number(e.target.value), dotted: entry.isDotted, triplet: entry.isTriplet })}>
            {DURATION_OPTIONS.map((option) => (
              <option key={option.base} value={option.base}>
                {option.label} ({option.key})
              </option>
            ))}
          </select>
        </label>
        <button className={`${styles.button} ${entry.isDotted ? styles.on : ''}`} aria-pressed={entry.isDotted} onClick={() => set({ entry: { ...entry, isDotted: !entry.isDotted, isTriplet: false } })} data-hint="Dotted: typed notes are half as long again (key .)">
          Dotted
        </button>
        <button className={`${styles.button} ${entry.isTriplet ? styles.on : ''}`} aria-pressed={entry.isTriplet} onClick={() => set({ entry: { ...entry, isTriplet: !entry.isTriplet, isDotted: false } })} data-hint="Triplet: typed notes are two thirds as long, three in the time of two (key T)">
          Triplet
        </button>
        <span className={styles.group} role="group" aria-label="Files">
          <button className={styles.button} disabled={!hasParts} onClick={() => report(services, printSheet(services))} data-hint="Print the sheet, or choose Save as PDF in the print dialog">
            Print…
          </button>
          <button className={styles.button} disabled={!hasParts} onClick={() => report(services, exportMusicXml(services))} data-hint="Save this part as a MusicXML file, which MuseScore, Sibelius, Finale and Dorico open">
            Save MusicXML
          </button>
          <button className={styles.button} onClick={() => void importMusicXmlDialog(services)} data-hint="Read the notes of a MusicXML file into the selected channel in this pattern (one undo step)">
            Import MusicXML…
          </button>
        </span>
        <span className={styles.status} data-hint="The song’s key and meter. Middle C is written C4 here (the piano roll calls it C5)">
          {timeSig.num}/{timeSig.den} · {signature.name} · typing {entryName(entry)}
        </span>
      </div>
      <div ref={host} className={styles.host}>
        {!hasParts && <EmptyState />}
        <div ref={content} />
      </div>
    </div>
  );
}
