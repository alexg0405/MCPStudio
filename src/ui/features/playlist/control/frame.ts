/**
 * One frame of the playlist, on the shared frame loop: follow the playhead, slide or redraw the layers that need it,
 * and move the playhead line. Idle playback does no React work and (apart from the pictures sliding) no drawing.
 */
import type { Project } from '@core/model/types';
import { fitCanvas, readTheme } from '../../../timeline/canvas';
import { placeScrollThumb } from '../../../timeline/scrollbar';
import { drawLaneHeaders } from '../lane-headers';
import { HEADER_WIDTH, RULER_HEIGHT } from '../layout';
import { updateAskPill } from './ask-target';
import type { PlaylistContext } from './context';
import { currentProject, maxScrollTick, mutedLanesOf, shownLaneOrder, shownLanes } from './lanes';
import type { LayerDrawers } from './layers';
import { drawOverlay } from './overlay';
import { followPlayhead, updatePlayhead } from './playhead';

/** Runs one frame. */
export function runFrame(ctx: PlaylistContext, drawers: LayerDrawers): void {
  const { vp, state, layers } = ctx;
  const project = currentProject(ctx);
  vp.rows = shownLaneOrder(ctx, project).length;
  followPlayhead(ctx, project);
  syncPixelSnap(ctx);
  const dirty = state.dirty;
  const now = performance.now();
  // The three panned layers decide for themselves whether the picture must be drawn again (dirty, zoom, size, scrolled
  // out of the drawn part); a plain scroll only slides it.
  layers.grid.paint(vp, vp.height, dirty.has('grid'), drawers.grid, now);
  layers.clips.paint(vp, vp.height, dirty.has('clips'), drawers.clips, now);
  layers.ruler.paint(vp, RULER_HEIGHT, dirty.has('ruler'), drawers.ruler, now);
  if (dirty.size > 0) {
    if (dirty.has('overlay')) drawOverlay(ctx);
    if (dirty.has('headers')) drawHeaders(ctx, project);
    dirty.clear();
    state.lastBarScroll = NaN;
  }
  if (vp.scrollTick !== state.lastBarScroll) {
    state.lastBarScroll = vp.scrollTick;
    placeScrollThumb(ctx.els.hthumb, vp, maxScrollTick(project), state.scrollTrackWidth);
    updateAskPill(ctx, project);
  }
  // A take being recorded grows every frame.
  if (ctx.s.audioRecorder.live.getState().take) ctx.invalidate('overlay');
  updatePlayhead(ctx);
}

/**
 * Drawing and the playhead snap to whole device pixels (viewport.ts); the grid and the playhead carry the same offset in
 * a data attribute, which the tests and the layout read.
 */
function syncPixelSnap(ctx: PlaylistContext): void {
  const { vp, state, els } = ctx;
  const snapPx = vp.snapForFrame(window.devicePixelRatio || 1);
  if (snapPx === state.lastSnapPx) return;
  state.lastSnapPx = snapPx;
  els.grid.dataset.snapPx = String(snapPx);
  els.playhead.dataset.snapPx = String(snapPx);
}

/** The track header column (it does not change with the horizontal view). */
function drawHeaders(ctx: PlaylistContext, project: Project): void {
  const { vp, state, els } = ctx;
  state.drawnHeaderRow = vp.scrollRow;
  state.drawnHeaderRowHeight = vp.rowHeight;
  const editor = ctx.s.editor.getState();
  const heardClip = editor.auditionTake;
  const heardLane = (heardClip && project.playlist.clips[heardClip]?.laneId) || null;
  drawLaneHeaders(fitCanvas(els.headers, HEADER_WIDTH, vp.height), vp, readTheme(), shownLanes(ctx, project), HEADER_WIDTH, {
    muted: mutedLanesOf(project),
    openTakes: new Set(editor.openTakes),
    heardLane,
  });
}
