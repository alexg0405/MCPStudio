import type { Services } from '@app/services';
import { newId } from '@core/model/ids';
import type { Clip } from '@core/model/types';
import { addClips, removeClips } from '@core/ops/playlist';
import { clipsSorted } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';

/** Playlist edit commands acting on the clip selection (usable from shortcuts, menus and tests). */
function selected(s: Services): Clip[] {
  const p = s.doc.getState().project;
  return s.editor
    .getState()
    .clipSelection.map((id) => p.playlist.clips[id])
    .filter((c): c is Clip => !!c);
}

export const playlistCommands = {
  selectAll(s: Services) {
    s.editor.getState().selectClips(clipsSorted(s.doc.getState().project.playlist.clips).map((c) => c.id));
  },
  deselect(s: Services) {
    s.editor.getState().selectClips([]);
  },
  deleteSelection(s: Services) {
    const ids = selected(s).map((c) => c.id);
    if (ids.length === 0) return;
    s.history.transact(ids.length > 1 ? 'Delete clips' : 'Delete clip', (d) => removeClips(d, ids));
    s.editor.getState().selectClips([]);
  },
  copy(s: Services) {
    const sel = selected(s);
    if (sel.length === 0) return;
    const start = Math.min(...sel.map((c) => c.start));
    s.editor.getState().setClipClipboard(sel.map((c) => ({ ...c, start: c.start - start })));
  },
  cut(s: Services) {
    playlistCommands.copy(s);
    playlistCommands.deleteSelection(s);
  },
  /** Pastes after the selection (next bar), or at the song position. */
  paste(s: Services) {
    const clip = s.editor.getState().clipClipboard;
    if (!clip?.length) return;
    const p = s.doc.getState().project;
    const bar = ticksPerBar(p.transport.timeSig);
    const sel = selected(s);
    const at = sel.length
      ? Math.ceil(Math.max(...sel.map((c) => c.start + c.length)) / bar) * bar
      : s.view.getState().songStart;
    const clips = clip.map((c) => ({ ...c, id: newId.clip(), start: c.start + at }));
    s.history.transact('Paste clips', (d) => addClips(d, clips));
    s.editor.getState().selectClips(clips.map((c) => c.id));
  },
  /** Copies the selection right after itself (rounded to bars). */
  duplicate(s: Services) {
    const sel = selected(s);
    if (sel.length === 0) return;
    const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
    const start = Math.min(...sel.map((c) => c.start));
    const end = Math.max(...sel.map((c) => c.start + c.length));
    const span = Math.max(bar, Math.ceil((end - start) / bar) * bar);
    const copies = sel.map((c) => ({ ...c, id: newId.clip(), start: c.start + span }));
    s.history.transact('Duplicate clips', (d) => addClips(d, copies));
    s.editor.getState().selectClips(copies.map((c) => c.id));
  },
};
