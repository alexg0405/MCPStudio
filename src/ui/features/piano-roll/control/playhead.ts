/** The playhead line, and the view following it while playing. Both run on the frame loop: no React, nothing allocated. */
import { isReducedMotion } from '../../../a11y/preferences';
import { isContextMenuOpen } from '../../../controls/ContextMenu';
import { patternTickAt } from '@core/query/playlist';
import type { EditTarget, PianoRollContext } from './context';
import { maxScrollTick, patternEnd } from './target';

/** The playhead in this pattern's ticks; NaN when stopped or (song mode) no clip of it is playing. */
function playheadTick(ctx: PianoRollContext, target: EditTarget): number {
  const { engine, view } = ctx.s;
  if (!engine.playing || !target.pattern || !target.patternId) return NaN;
  if (view.getState().mode === 'pattern') return engine.playhead() % patternEnd(target);
  // Song mode: follow the clip of this pattern that's playing, if any.
  return patternTickAt(target.project, engine.playhead(), target.patternId) ?? NaN;
}

/**
 * Follow playhead (FL's auto-scroll), for the current pattern in pattern mode and for its clip that plays in song mode:
 * near the right edge the view glides a page on (or slides with the playhead, in the smooth style). It holds still while
 * the user drags, selects or has a menu open, and after a hand scroll until the playhead is back in view.
 */
export function followPlayhead(ctx: PianoRollContext, target: EditTarget): void {
  const { s, state, vp } = ctx;
  const playing = s.engine.playing;
  const enabled = s.prefs.getState().followPlayhead;
  const playhead = playing && enabled ? playheadTick(ctx, target) : NaN;
  const visibleTicks = vp.width / vp.pxPerTick;
  // The frame's inputs go into the one record this editor keeps (see followFrame).
  const frame = ctx.followFrame;
  frame.now = performance.now();
  frame.enabled = enabled;
  frame.playing = playing;
  frame.playhead = playhead;
  frame.scrollTick = vp.scrollTick;
  frame.visible = visibleTicks;
  frame.maxScroll = Number.isFinite(playhead) ? Math.max(0, maxScrollTick(ctx, target) - visibleTicks) : 0;
  // The pattern loops at its end (in song mode its clip repeats it).
  frame.wrapEnd = patternEnd(target);
  frame.style = s.prefs.getState().followStyle;
  frame.reducedMotion = isReducedMotion();
  frame.busy = state.drag !== null || isContextMenuOpen();
  const next = ctx.follow.step(frame);
  if (next === null) {
    if (!playing && state.followMoved) {
      state.followMoved = false;
      ctx.viewportSaver.flush();
    }
    return;
  }
  vp.scrollTick = next;
  state.followMoved = true;
  // The grid, notes, ruler and lane slide (see the frame); only what is drawn at the pointer, and the keyboard cursor, follow by redrawing.
  if (state.hover || state.stampHover || state.drag || state.keyboard.isActive) ctx.invalidate('overlay');
}

/** Places the playhead line at the playing position (hidden when there is none). */
export function updatePlayhead(ctx: PianoRollContext, target: EditTarget): void {
  const tick = playheadTick(ctx, target);
  ctx.playheadLine.place(ctx.vp, Number.isFinite(tick) ? ctx.vp.tickToX(tick) : NaN);
}
