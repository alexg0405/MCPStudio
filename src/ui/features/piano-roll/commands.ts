/**
 * Piano roll edit commands. They act on the selected channel in the current pattern and the note
 * selection in the editor store, so they work from shortcuts, menus or tests alike.
 */
import type { Services } from '@app/services';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, NoteId, PatternId } from '@core/model/types';
import { addNotes, editNotes, removeNotes } from '@core/ops/notes';
import { noteBounds } from '@core/query/notes-hit';
import { notesSorted } from '@core/query/queries';
import { ticksPerBar } from '@core/time/ppq';
import { gridTicks, snapRound } from '@core/time/snap';

export interface NoteTarget {
  channelId: ChannelId;
  patternId: PatternId;
  notes: readonly Note[];
  selected: Note[];
}

export function noteTarget(s: Services): NoteTarget | null {
  const p = s.doc.getState().project;
  const channelId = s.session.getState().selectedChannelId;
  const patternId = s.view.getState().currentPatternId;
  const ch = channelId ? p.channels[channelId] : undefined;
  const pattern = patternId ? p.patterns[patternId] : undefined;
  if (!channelId || !patternId || !pattern || ch?.kind !== 'instrument') return null;
  const notes = notesSorted(pattern.notes[channelId]);
  const sel = new Set(s.editor.getState().noteSelection);
  return { channelId, patternId, notes, selected: notes.filter((n) => sel.has(n.id)) };
}

/** The selection, or every note when nothing is selected (FL applies tools to all notes then). */
function selectionOrAll(t: NoteTarget): Note[] {
  return t.selected.length > 0 ? t.selected : [...t.notes];
}

function grid(s: Services): number {
  const p = s.doc.getState().project;
  const pr = s.editor.getState().pianoRoll;
  return gridTicks(pr.snap, p.transport.timeSig, pr.pxPerTick);
}

export const pianoRollCommands = {
  selectAll(s: Services) {
    const t = noteTarget(s);
    if (t) s.editor.getState().selectNotes(t.notes.map((n) => n.id));
  },

  deselect(s: Services) {
    s.editor.getState().selectNotes([]);
  },

  deleteSelection(s: Services) {
    const t = noteTarget(s);
    if (!t || t.selected.length === 0) return;
    const ids = t.selected.map((n) => n.id);
    s.history.transact(ids.length > 1 ? 'Delete notes' : 'Delete note', (d) =>
      removeNotes(d, t.patternId, t.channelId, ids),
    );
    s.editor.getState().selectNotes([]);
  },

  copy(s: Services) {
    const t = noteTarget(s);
    if (!t || t.selected.length === 0) return;
    const start = Math.min(...t.selected.map((n) => n.tick));
    s.editor.getState().setNoteClipboard(t.selected.map((n) => ({ ...n, tick: n.tick - start })));
  },

  cut(s: Services) {
    pianoRollCommands.copy(s);
    pianoRollCommands.deleteSelection(s);
  },

  /** Pastes at the playhead when playing, else right after the selection (or at the start). */
  paste(s: Services) {
    const t = noteTarget(s);
    const clip = s.editor.getState().noteClipboard;
    if (!t || !clip || clip.length === 0) return;
    const g = grid(s);
    const sel = noteBounds(t.selected);
    // After the selection's end (next grid line), or at the playhead while playing.
    const at = s.engine.playing ? snapRound(s.engine.playhead(), g) : sel ? Math.ceil(sel.end / g) * g : 0;
    const notes = clip.map((n) => ({ ...n, id: newId.note() as NoteId, tick: n.tick + at }));
    s.history.transact('Paste notes', (d) => addNotes(d, t.patternId, t.channelId, notes));
    s.editor.getState().selectNotes(notes.map((n) => n.id));
  },

  /** FL's Ctrl+B: copies the selection right after itself (rounded up to a bar for long selections). */
  duplicate(s: Services) {
    const t = noteTarget(s);
    if (!t) return;
    const src = selectionOrAll(t);
    const b = noteBounds(src);
    if (!b) return;
    const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
    const g = grid(s);
    const span = b.end - b.start;
    const step = span >= bar ? Math.ceil(span / bar) * bar : Math.max(g, Math.ceil(span / g) * g);
    const copies = src.map((n) => ({ ...n, id: newId.note() as NoteId, tick: n.tick + step }));
    s.history.transact('Duplicate notes', (d) => addNotes(d, t.patternId, t.channelId, copies));
    s.editor.getState().selectNotes(copies.map((n) => n.id));
  },

  transpose(s: Services, semitones: number) {
    const t = noteTarget(s);
    if (!t) return;
    const src = selectionOrAll(t);
    if (src.length === 0) return;
    const lo = Math.min(...src.map((n) => n.key));
    const hi = Math.max(...src.map((n) => n.key));
    const by = Math.max(-lo, Math.min(127 - hi, semitones));
    if (by === 0) return;
    s.history.transact(
      'Transpose',
      (d) =>
        editNotes(
          d,
          t.patternId,
          t.channelId,
          src.map((n) => ({ id: n.id, key: n.key + by })),
        ),
      { mergeKey: `transpose:${t.channelId}` },
    );
  },

  nudge(s: Services, direction: 1 | -1) {
    const t = noteTarget(s);
    if (!t || t.selected.length === 0) return;
    const g = grid(s);
    const min = Math.min(...t.selected.map((n) => n.tick));
    const by = direction < 0 ? -Math.min(g, min) : g;
    if (by === 0) return;
    s.history.transact(
      'Nudge notes',
      (d) =>
        editNotes(
          d,
          t.patternId,
          t.channelId,
          t.selected.map((n) => ({ id: n.id, tick: n.tick + by })),
        ),
      { mergeKey: `nudge:${t.channelId}` },
    );
  },

  /** Snaps note starts to the grid (FL's quick quantize, Alt+Q). */
  quantize(s: Services) {
    const t = noteTarget(s);
    if (!t) return;
    const g = grid(s);
    const src = selectionOrAll(t);
    const edits = src
      .map((n) => ({ id: n.id, tick: Math.max(0, snapRound(n.tick, g)) }))
      .filter((e, i) => e.tick !== src[i]?.tick);
    if (edits.length === 0) return;
    s.history.transact('Quantize', (d) => editNotes(d, t.patternId, t.channelId, edits));
  },
};
