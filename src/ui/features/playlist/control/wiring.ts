/** Connecting the playlist editor to the rest of the app: what marks layers dirty, and which element events go where. */
import { pointerClip } from '@app/actions/comp';
import type { CleanupList } from '../../../timeline/listeners';
import { onThemeChange } from '../../../timeline/canvas';
import { markerRename } from '../markers';
import type { PlaylistContext } from './context';
import { updateCursor } from './cursor';
import { onDoubleClick } from './double-click';
import { onDragOver, onDrop } from './drop';
import { onHeaderDouble, onHeaderDown } from './header-pointer';
import { renameMarker } from './marker-rename';
import { cancelDrag, onPointerDown, onPointerLeave, onPointerMove, onPointerUp } from './pointer';
import { onRulerDouble, onRulerDown, onRulerMove, onRulerUp, setMarkerHot } from './ruler-pointer';
import { measureLayout, onThumbDown, onWheel } from './viewport-control';

/** Marks every layer dirty. */
function invalidateAll(ctx: PlaylistContext): void {
  ctx.invalidate('grid', 'clips', 'overlay', 'headers', 'ruler');
}

/** Redraws what a change in the project, the editor settings or the view affects. */
export function subscribeToChanges(ctx: PlaylistContext, cleanups: CleanupList): void {
  const { s } = ctx;
  cleanups.add(
    s.doc.subscribe((next, prev) => {
      const now = next.project;
      const before = prev.project;
      const changed =
        now.playlist !== before.playlist ||
        now.patterns !== before.patterns ||
        now.channels !== before.channels ||
        now.transport !== before.transport;
      if (changed) invalidateAll(ctx);
    }),
    s.editor.subscribe((next, prev) => {
      if (next.clipSelection !== prev.clipSelection) ctx.invalidate('clips');
      if (next.openTakes !== prev.openTakes) invalidateAll(ctx);
      if (next.auditionTake !== prev.auditionTake) ctx.invalidate('clips', 'headers');
      if (next.playlist.snap !== prev.playlist.snap) invalidateAll(ctx);
      if (next.playlist.tool !== prev.playlist.tool) updateCursor(ctx);
    }),
    s.view.subscribe((next, prev) => {
      if (next.loop !== prev.loop || next.mode !== prev.mode) ctx.invalidate('ruler');
      if (next.punch !== prev.punch) ctx.invalidate('ruler', 'grid');
      if (next.currentPatternId !== prev.currentPatternId) ctx.invalidate('clips');
    }),
    // A sample finished decoding: its clips can show their waveform now.
    s.engine.subscribe(() => ctx.invalidate('clips')),
    onThemeChange(() => invalidateAll(ctx)),
    // A take being recorded grows on the playlist.
    s.audioRecorder.live.subscribe(() => ctx.invalidate('overlay')),
    // Alt+T and "Rename…" ask for a marker's name right on the ruler.
    markerRename.subscribe(({ id }) => {
      if (!id) return;
      markerRename.setState({ id: null });
      // After the new marker is drawn, so the field sits on its flag.
      requestAnimationFrame(() => renameMarker(ctx, id));
    }),
  );
}

/** Pointer, wheel, drag and drop events of the grid, the ruler, the track headers and the scrollbar. */
export function listenToElements(ctx: PlaylistContext, cleanups: CleanupList): void {
  const { els } = ctx;
  const resizeObserver = new ResizeObserver(() => measureLayout(ctx));
  resizeObserver.observe(els.gridHost);
  resizeObserver.observe(els.hscroll);
  cleanups.add(() => resizeObserver.disconnect());

  const grid = els.gridHost;
  cleanups.listen(grid, 'pointerdown', (event) => onPointerDown(ctx, event));
  cleanups.listen(grid, 'pointermove', (event) => onPointerMove(ctx, event));
  cleanups.listen(grid, 'pointerup', (event) => onPointerUp(ctx, event));
  cleanups.listen(grid, 'pointercancel', () => cancelDrag(ctx));
  cleanups.listen(grid, 'dblclick', (event) => onDoubleClick(ctx, event));
  cleanups.listen(grid, 'contextmenu', (event) => event.preventDefault());
  cleanups.listen(grid, 'pointerleave', () => onPointerLeave(ctx));
  // Native, non-passive wheel listeners so preventDefault works (React's onWheel is passive).
  for (const element of [grid, els.headers, els.ruler]) {
    cleanups.listen(element, 'wheel', (event) => onWheel(ctx, event), { passive: false });
  }
  cleanups.listen(grid, 'dragover', (event) => onDragOver(event));
  cleanups.listen(grid, 'drop', (event) => onDrop(ctx, event));

  cleanups.listen(els.headers, 'pointerdown', (event) => onHeaderDown(ctx, event));
  cleanups.listen(els.headers, 'dblclick', (event) => onHeaderDouble(ctx, event));
  cleanups.listen(els.headers, 'contextmenu', (event) => event.preventDefault());

  cleanups.listen(els.ruler, 'pointerdown', (event) => onRulerDown(ctx, event));
  cleanups.listen(els.ruler, 'pointermove', (event) => onRulerMove(ctx, event));
  cleanups.listen(els.ruler, 'pointerup', (event) => onRulerUp(ctx, event));
  cleanups.listen(els.ruler, 'pointercancel', () => cancelDrag(ctx));
  cleanups.listen(els.ruler, 'contextmenu', (event) => event.preventDefault());
  cleanups.listen(els.ruler, 'pointerleave', () => setMarkerHot(ctx, null));
  cleanups.listen(els.ruler, 'dblclick', (event) => onRulerDouble(ctx, event));

  cleanups.listen(els.hthumb, 'pointerdown', (event) => onThumbDown(ctx, event));
  cleanups.cancelOnEscape(
    () => ctx.state.drag !== null,
    () => cancelDrag(ctx),
  );
}

/** Forgets the clip under the pointer when the editor closes (other windows read it for their shortcuts). */
export function forgetPointerClip(): void {
  pointerClip.id = null;
}
