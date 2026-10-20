/** Connecting the piano roll editor to the rest of the app: what marks layers dirty, and which element events go where. */
import type { CleanupList } from '../../../timeline/listeners';
import { onThemeChange } from '../../../timeline/canvas';
import type { PianoRollContext } from './context';
import { updateCursor } from './cursor';
import { onLaneDown, onLaneMove, onLaneUp } from './event-lane';
import { onKeysDown, onKeysMove, onKeysUp } from './keys-pointer';
import { cancelDrag, onPointerDown, onPointerLeave, onPointerMove, onPointerUp } from './pointer';
import { listenToTouch } from './touch';
import { measureLayout, onThumbDown, onWheel } from './viewport-control';

/** Marks every layer dirty. */
function invalidateAll(ctx: PianoRollContext): void {
  ctx.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'lane');
}

/** Redraws what a change in the project, the editor settings, the selection or the view affects. */
export function subscribeToChanges(ctx: PianoRollContext, cleanups: CleanupList): void {
  const { s, state } = ctx;
  cleanups.add(
    s.doc.subscribe((next, prev) => {
      const now = next.project;
      const before = prev.project;
      if (now.patterns !== before.patterns || now.channels !== before.channels) invalidateAll(ctx);
      if (now.transport !== before.transport) invalidateAll(ctx);
      // The chord track and where the pattern plays decide the chord tint behind the notes.
      if (now.chords !== before.chords || now.playlist !== before.playlist) ctx.invalidate('grid');
      // The lyrics are written under the notes they are sung on.
      if (now.lyrics !== before.lyrics || now.playlist !== before.playlist) ctx.invalidate('notes');
    }),
    s.editor.subscribe((next, prev) => {
      const now = next.pianoRoll;
      const before = prev.pianoRoll;
      if (next.noteSelection !== prev.noteSelection) ctx.invalidate('notes', 'lane');
      if (now.snap !== before.snap || now.ghosts !== before.ghosts) invalidateAll(ctx);
      if (now.velocityLane !== before.velocityLane || now.lane !== before.lane) invalidateAll(ctx);
      if (now.scaleHighlight !== before.scaleHighlight) ctx.invalidate('grid', 'keys');
      if (now.chordHighlight !== before.chordHighlight) ctx.invalidate('grid');
      if (now.tool !== before.tool || now.chord !== before.chord) {
        state.stampHover = null;
        ctx.invalidate('overlay');
        updateCursor(ctx);
      }
    }),
    s.session.subscribe((next, prev) => {
      if (next.selectedChannelId === prev.selectedChannelId) return;
      state.hover = null;
      invalidateAll(ctx);
    }),
    s.view.subscribe((next, prev) => {
      if (next.currentPatternId !== prev.currentPatternId) invalidateAll(ctx);
    }),
    onThemeChange(() => invalidateAll(ctx)),
  );
}

/** Pointer and wheel events of the grid, the keys, the ruler, the event lane and the scrollbar. */
export function listenToElements(ctx: PianoRollContext, cleanups: CleanupList): void {
  const { els } = ctx;
  const resizeObserver = new ResizeObserver(() => measureLayout(ctx));
  resizeObserver.observe(els.gridHost);
  resizeObserver.observe(els.velocityHost);
  resizeObserver.observe(els.hscroll);
  cleanups.add(() => resizeObserver.disconnect());

  const grid = els.gridHost;
  cleanups.listen(grid, 'pointerdown', (event) => onPointerDown(ctx, event));
  cleanups.listen(grid, 'pointermove', (event) => onPointerMove(ctx, event));
  cleanups.listen(grid, 'pointerup', (event) => onPointerUp(ctx, event));
  cleanups.listen(grid, 'pointercancel', () => cancelDrag(ctx));
  cleanups.listen(grid, 'pointerleave', () => onPointerLeave(ctx));
  cleanups.listen(grid, 'contextmenu', (event) => event.preventDefault());
  // Native, non-passive wheel listeners so preventDefault works (React's onWheel is passive).
  for (const element of [grid, els.keys, els.ruler, els.velocityHost]) {
    cleanups.listen(element, 'wheel', (event) => onWheel(ctx, event), { passive: false });
  }

  cleanups.listen(els.keys, 'pointerdown', (event) => onKeysDown(ctx, event));
  cleanups.listen(els.keys, 'pointermove', (event) => onKeysMove(ctx, event));
  cleanups.listen(els.keys, 'pointerup', (event) => onKeysUp(ctx, event));
  cleanups.listen(els.keys, 'pointercancel', (event) => onKeysUp(ctx, event));

  cleanups.listen(els.velocityHost, 'pointerdown', (event) => onLaneDown(ctx, event));
  cleanups.listen(els.velocityHost, 'pointermove', (event) => onLaneMove(ctx, event));
  cleanups.listen(els.velocityHost, 'pointerup', (event) => onLaneUp(ctx, event));
  cleanups.listen(els.velocityHost, 'pointercancel', () => cancelDrag(ctx));
  cleanups.listen(els.velocityHost, 'contextmenu', (event) => event.preventDefault());

  cleanups.listen(els.hthumb, 'pointerdown', (event) => onThumbDown(ctx, event));
  cleanups.cancelOnEscape(
    () => ctx.state.drag !== null,
    () => cancelDrag(ctx),
  );
  // Registered last, but it listens while capturing, so it sees touches before the listeners above.
  listenToTouch(ctx, cleanups);
}
