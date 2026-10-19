/**
 * Touch on the piano roll: the grid, the ruler and the event lane are touch surfaces (`ui/touch/surface.ts`). One finger
 * does what the current tool does with a mouse; two fingers pan and pinch the view (the lane only follows the sideways
 * part, its height is its value); a finger that rests opens the note's or the empty spot's context menu.
 */
import type { CleanupList } from '../../../timeline/listeners';
import { applyTwoFingers } from '../../../timeline/touch-view';
import type { TwoFingerFrame } from '../../../touch/recognizer';
import { attachTouchSurface } from '../../../touch/surface';
import { asWritable, type PianoRollContext } from './context';
import { hitTest, localPoint } from './hit-test';
import { openMenu } from './menu';
import { cancelDrag } from './pointer';
import { editTarget, maxScrollTick } from './target';
import { viewportChanged } from './viewport-control';

/** Two fingers moved: pan, and zoom time (horizontal pinch) and key height (vertical pinch). */
function panAndZoom(ctx: PianoRollContext, frame: TwoFingerFrame): void {
  const rect = ctx.els.gridHost.getBoundingClientRect();
  const outcome = applyTwoFingers(ctx.vp, frame, rect.left, rect.top, maxScrollTick(ctx, editTarget(ctx)));
  // The same follow rules as the wheel: zooming keeps following, a sideways scroll by hand makes it wait.
  if (outcome === 'zoomed-time') ctx.follow.zoomed();
  else if (outcome === 'scrolled-sideways') ctx.follow.userScrolled();
  viewportChanged(ctx);
}

/** The event lane's height is its value, so two fingers there only move and zoom the time axis. */
function panAndZoomTime(ctx: PianoRollContext, frame: TwoFingerFrame): void {
  frame.panY = 0;
  frame.scaleY = 1;
  panAndZoom(ctx, frame);
}

/** A long press on the grid: the menu of the note under the finger (it becomes the selection), or of the empty spot. */
function openGridMenu(ctx: PianoRollContext, clientX: number, clientY: number): void {
  const target = asWritable(editTarget(ctx));
  if (!target) return;
  const at = { clientX, clientY };
  const { x, y } = localPoint(ctx, at);
  openMenu(ctx, at, target, hitTest(ctx, x, y, target));
}

/** Makes the grid, the ruler and the event lane touch surfaces. */
export function listenToTouch(ctx: PianoRollContext, cleanups: CleanupList): void {
  const { els } = ctx;
  const drop = (): void => cancelDrag(ctx);
  attachTouchSurface(
    els.gridHost,
    { cancelDrag: drop, twoFinger: (frame) => panAndZoom(ctx, frame), longPress: (x, y) => openGridMenu(ctx, x, y) },
    cleanups,
  );
  attachTouchSurface(els.ruler, { cancelDrag: drop, twoFinger: (frame) => panAndZoom(ctx, frame) }, cleanups);
  attachTouchSurface(els.velocityHost, { cancelDrag: drop, twoFinger: (frame) => panAndZoomTime(ctx, frame) }, cleanups);
}
