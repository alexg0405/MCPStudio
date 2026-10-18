/**
 * The overlay canvas over the clips: what follows the pointer and what is not part of the project yet. The clip under
 * the pointer lifts, a comp swipe, the rubber band, the slice line, the value being dragged, the take being recorded.
 */
import { alpha, fitCanvas, readTheme, roundRectPath, type TimelineTheme } from '../../../timeline/canvas';
import { drawSelectionBox } from '../../../timeline/selection-box';
import { drawReadout } from '../automation';
import { CLIP_RADIUS, clipBox } from '../clip-geometry';
import { clipPaint } from '../clip-paint';
import { clipColorOf } from '../draw-clips';
import type { Clip } from '@core/model/types';
import type { PlaylistContext } from './context';
import type { CompDrag } from './drag';
import { boxOfClip } from './hit-test';
import { currentProject, laneRow } from './lanes';
import { drawLiveTake } from './live-take';
import { takeGroups } from '@core/query/takes';

/** True when the overlay has anything to show now. */
function hasOverlayContent(ctx: PlaylistContext, isRecording: boolean): boolean {
  const { drag, hover } = ctx.state;
  if (isRecording) return true;
  if (!drag) return !!hover;
  if (drag.kind === 'marquee' || drag.kind === 'comp') return true;
  return (drag.kind === 'point' || drag.kind === 'tension') && !!drag.readout;
}

/** Redraws the overlay canvas (dirty frames only). */
export function drawOverlay(ctx: PlaylistContext): void {
  const { vp, els, state } = ctx;
  const live = ctx.s.audioRecorder.live.getState().take;
  const hasContent = hasOverlayContent(ctx, !!live);
  // Nothing to show before and after (every zoom and scroll frame asks): a clear would still re-raster the canvas.
  if (!hasContent && state.overlayBlank) return;
  state.overlayBlank = !hasContent;
  const canvas = fitCanvas(els.overlay, vp.width, vp.height);
  canvas.clearRect(0, 0, vp.width, vp.height);
  if (live) drawLiveTake(ctx, canvas, live, readTheme());
  const drag = state.drag;
  if (!drag && state.hover) drawHoverEdge(ctx, canvas, state.hover.clip);
  if (drag?.kind === 'comp') drawCompSwipe(ctx, canvas, drag);
  if (drag?.kind === 'marquee') {
    drawSelectionBox(canvas, vp, readTheme(), drag);
  } else if (state.hover && !drag && ctx.s.editor.getState().playlist.tool === 'slice' && state.sliceLineX >= 0) {
    drawSliceLine(ctx, canvas, state.hover.clip);
  } else if ((drag?.kind === 'point' || drag?.kind === 'tension') && drag.readout) {
    // The value being set, in its units (and where).
    drawReadout(canvas, readTheme(), drag.readout.x, drag.readout.y, drag.readout.text, vp);
  }
}

/** The clip under the pointer lifts a little: a brighter edge around it. */
function drawHoverEdge(ctx: PlaylistContext, canvas: CanvasRenderingContext2D, clip: Clip): void {
  const project = currentProject(ctx);
  const box = boxOfClip(ctx, clip, project);
  if (!box || ctx.s.editor.getState().clipSelection.includes(clip.id)) return;
  const theme = readTheme();
  canvas.strokeStyle = clipPaint(clipColorOf(project, clip, theme), theme).hoverEdge;
  canvas.beginPath();
  roundRectPath(canvas, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, CLIP_RADIUS - 0.5);
  canvas.stroke();
}

/** The part of a take being swiped: a band on the take and on the comp track above it. */
function drawCompSwipe(ctx: PlaylistContext, canvas: CanvasRenderingContext2D, drag: CompDrag): void {
  const { vp } = ctx;
  const project = currentProject(ctx);
  const theme: TimelineTheme = readTheme();
  const from = Math.max(drag.clip.start, Math.min(drag.t0, drag.t1));
  const to = Math.min(drag.clip.start + drag.clip.length, Math.max(drag.t0, drag.t1));
  if (to <= from) return;
  const group = takeGroups(project).find((candidate) => candidate.id === drag.group);
  const compRow = group?.compLane ? laneRow(ctx, project, group.compLane) : -1;
  for (const row of [laneRow(ctx, project, drag.clip.laneId), compRow]) {
    if (row < 0) continue;
    const box = clipBox(vp, row, { start: from, length: to - from });
    canvas.fillStyle = alpha(theme.accent, 0.35);
    canvas.fillRect(box.x, box.y, box.w + 1, box.h);
    canvas.strokeStyle = theme.accent;
    canvas.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h - 1);
  }
}

/** The slice tool's cut line: where a click would cut the clip under the pointer. */
function drawSliceLine(ctx: PlaylistContext, canvas: CanvasRenderingContext2D, clip: Clip): void {
  const { vp, state } = ctx;
  const row = laneRow(ctx, currentProject(ctx), clip.laneId);
  canvas.fillStyle = readTheme().danger;
  canvas.fillRect(vp.snap(state.sliceLineX), vp.snap(vp.rowToY(row)), 1, vp.rowHeight);
}
