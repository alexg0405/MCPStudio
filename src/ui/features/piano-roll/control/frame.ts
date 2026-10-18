/**
 * One frame of the piano roll, on the shared frame loop: follow the playhead, slide or redraw the layers that need it,
 * and move the playhead line. Idle playback does no React work and (apart from the pictures sliding) no drawing.
 */
import { fitCanvas, readTheme } from '../../../timeline/canvas';
import { placeScrollThumb } from '../../../timeline/scrollbar';
import { KEYS_WIDTH, RULER_HEIGHT } from '../layout';
import { drawKeys } from '../render';
import type { EditTarget, PianoRollContext } from './context';
import type { LayerDrawers } from './layers';
import { drawOverlay } from './overlay';
import { followPlayhead, updatePlayhead } from './playhead';
import { centerOnNotes } from './viewport-control';
import { editTarget, maxScrollTick, scaleRowsOf } from './target';

/** Redraw timings for performance checks (`window.__ag.perf` in dev). */
export const pianoRollPerf = { lastDrawMs: 0, maxDrawMs: 0, draws: 0, notesDrawn: 0 };

/** Runs one frame. */
export function runFrame(ctx: PianoRollContext, drawers: LayerDrawers): void {
  const startedAt = performance.now();
  const { vp, state, els, layers } = ctx;
  const target = editTarget(ctx);
  centerFirstTime(ctx, target);
  followPlayhead(ctx, target);
  // Drawing and the playhead snap to whole device pixels (viewport.ts).
  vp.snapForFrame(window.devicePixelRatio || 1);
  const dirty = state.dirty;
  const showsLane = ctx.s.editor.getState().pianoRoll.velocityLane;
  // The panned layers decide for themselves whether the picture must be drawn again (dirty, zoom, size, scrolled out of
  // the drawn part); a plain scroll only slides it.
  let drew = layers.grid.paint(vp, vp.height, dirty.has('grid'), drawers.grid, startedAt);
  if (layers.notes.paint(vp, vp.height, dirty.has('notes'), drawers.notes, startedAt)) drew = true;
  if (layers.ruler.paint(vp, RULER_HEIGHT, dirty.has('ruler'), drawers.ruler, startedAt)) drew = true;
  if (showsLane && layers.lane.paint(vp, state.laneHeight, dirty.has('lane'), drawers.lane, startedAt)) drew = true;
  if (dirty.has('overlay')) drawOverlay(ctx);
  if (dirty.has('keys')) drawKeyStrip(ctx, target);
  if (dirty.size > 0 || vp.scrollTick !== state.lastBarScroll) {
    state.lastBarScroll = vp.scrollTick;
    placeScrollThumb(els.hthumb, vp, maxScrollTick(ctx, target), state.scrollTrackWidth);
  }
  if (drew || dirty.size > 0) recordDrawTime(startedAt, target);
  dirty.clear();
  updatePlayhead(ctx, target);
}

/** Center the view on the channel's notes the first time we show it (compared field by field: no key string per frame). */
function centerFirstTime(ctx: PianoRollContext, target: EditTarget): void {
  const centered = ctx.state.centeredFor;
  const isNew = !centered || centered.channelId !== target.channelId || centered.patternId !== target.patternId;
  if (!isNew || ctx.vp.height <= 1) return;
  ctx.state.centeredFor = { channelId: target.channelId, patternId: target.patternId };
  centerOnNotes(ctx, target);
}

/** The piano keys on the left, with the keys being held lit. */
function drawKeyStrip(ctx: PianoRollContext, target: EditTarget): void {
  const { vp, els, state } = ctx;
  drawKeys(
    fitCanvas(els.keys, KEYS_WIDTH, vp.height),
    vp,
    readTheme(),
    KEYS_WIDTH,
    new Set(state.pressedKeys.keys()),
    target.rootKey,
    scaleRowsOf(ctx, target),
  );
}

function recordDrawTime(startedAt: number, target: EditTarget): void {
  const ms = performance.now() - startedAt;
  pianoRollPerf.lastDrawMs = ms;
  pianoRollPerf.maxDrawMs = Math.max(pianoRollPerf.maxDrawMs, ms);
  pianoRollPerf.draws++;
  pianoRollPerf.notesDrawn = target.notes.length;
}
