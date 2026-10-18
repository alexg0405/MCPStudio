/**
 * What the grid, clips and ruler layers draw. Each is drawn into a picture wider than the view (timeline/panned.ts) and
 * only when it is stale (an edit, a zoom, a theme change), not on every frame.
 */
import type { AutomationClip, Clip, LaneId } from '@core/model/types';
import { compSegmentsOf } from '@core/ops/comp';
import { clipsSorted, songLength } from '@core/query/playlist';
import { takeGroups } from '@core/query/takes';
import { alpha, readTheme } from '../../../timeline/canvas';
import type { PanDraw } from '../../../timeline/panned';
import type { Viewport } from '../../../timeline/viewport';
import { drawClips, type ClipStyle } from '../draw-clips';
import { drawLanesGrid } from '../lane-grid';
import { drawMarkerLines, type RulerMarkers } from '../marker-flags';
import { drawPlaylistRuler } from '../ruler';
import { drawTakeUse } from '../take-use';
import { audioDrawStyle } from './audio-handles';
import { automationDrawStyle, automationLabel } from './automation-edit';
import type { PlaylistContext } from './context';
import { currentProject, laneRowsOf, mutedLanesOf, shownLaneOrder, sortedMarkersOf } from './lanes';
import type { Project } from '@core/model/types';

/** The tint down the tracks over the punch range, so you can see what a recording will keep. */
const PUNCH_TINT_ALPHA = 0.06;

/** What the ruler and the grid's marker lines draw for the markers (the sorted list is cached per project). */
function markersToDraw(ctx: PlaylistContext, project: Project): RulerMarkers {
  const { state } = ctx;
  return { markers: sortedMarkersOf(project), hot: state.markerHot, hotAsk: state.markerAskHot, drag: state.markerDrag };
}

/** The three drawing functions of the panned layers. */
export interface LayerDrawers {
  grid: PanDraw;
  clips: PanDraw;
  ruler: PanDraw;
}

/**
 * Builds the drawing functions once. `PannedLayer.paint` takes one every frame, so an inline arrow would be a closure per
 * frame. They read the state they draw when they run, which is only when the layer is stale.
 */
export function createLayerDrawers(ctx: PlaylistContext): LayerDrawers {
  const waveform: ClipStyle['waveform'] = (ref) => ctx.s.engine.waveform(ref);
  return {
    grid: (canvas, wide) => drawGridLayer(ctx, canvas, wide),
    clips: (canvas, wide) => drawClipsLayer(ctx, canvas, wide, waveform),
    ruler: (canvas, wide) => drawRulerLayer(ctx, canvas, wide),
  };
}

function drawGridLayer(ctx: PlaylistContext, canvas: CanvasRenderingContext2D, wide: Viewport): void {
  const project = currentProject(ctx);
  const theme = readTheme();
  drawLanesGrid(canvas, wide, theme, project.transport.timeSig, wide.rows);
  const punch = ctx.s.view.getState().punch;
  if (punch) {
    const x0 = wide.tickToPx(punch.start);
    canvas.fillStyle = alpha(theme.danger, PUNCH_TINT_ALPHA);
    canvas.fillRect(x0, 0, wide.tickToPx(punch.end) - x0, wide.height);
  }
  drawMarkerLines(canvas, wide, markersToDraw(ctx, project), theme);
}

function drawRulerLayer(ctx: PlaylistContext, canvas: CanvasRenderingContext2D, wide: Viewport): void {
  const project = currentProject(ctx);
  const { loop, punch } = ctx.s.view.getState();
  // Marker flags come back in picture coordinates; `markerHit` and friends add the picture's offset.
  ctx.state.markerBoxes = drawPlaylistRuler(canvas, wide, readTheme(), {
    timeSig: project.transport.timeSig,
    loop,
    punch,
    songEnd: songLength(project),
    markers: markersToDraw(ctx, project),
  });
}

function drawClipsLayer(
  ctx: PlaylistContext,
  canvas: CanvasRenderingContext2D,
  wide: Viewport,
  waveform: ClipStyle['waveform'],
): void {
  const { state } = ctx;
  const project = currentProject(ctx);
  const theme = readTheme();
  const muted = mutedLanesOf(project);
  canvas.clearRect(0, 0, wide.width, wide.height);
  const laneRows = laneRowsOf(shownLaneOrder(ctx, project));
  const selected = new Set(ctx.s.editor.getState().clipSelection);
  const label = (clip: Clip): string | undefined => (clip.kind === 'automation' ? automationLabel(ctx, clip, project) : undefined);
  const automation = (clip: AutomationClip) => automationDrawStyle(ctx, clip, project, selected);
  const drag = state.drag;
  // The clips being moved or resized are drawn from the preview; the originals are hidden.
  const hidesOriginals = state.preview && (drag?.kind === 'resize' || (drag?.kind === 'move' && !drag.duplicate));
  const skip = hidesOriginals ? new Set(state.preview?.map((clip) => clip.id)) : undefined;
  drawClips(
    canvas,
    wide,
    theme,
    project,
    clipsSorted(project.playlist.clips),
    laneRows,
    { selected, waveform, label, automation, ...audioDrawStyle(ctx, selected), ...(skip ? { skip } : {}) },
    muted,
  );
  drawTakeUseOnTakeTracks(ctx, canvas, wide, project, laneRows);
  if (state.preview) drawPreview(ctx, canvas, wide, project, laneRows, state.preview, { waveform, label });
}

/** Where each recording's comp uses each take, on the take tracks that are shown. */
function drawTakeUseOnTakeTracks(
  ctx: PlaylistContext,
  canvas: CanvasRenderingContext2D,
  wide: Viewport,
  project: Project,
  laneRows: ReadonlyMap<LaneId, number>,
): void {
  const groups = takeGroups(project);
  if (groups.length === 0) return;
  const useByGroup = groups.map((group) => ({ clips: group.takes.flatMap((take) => take.clips), segments: compSegmentsOf(group) }));
  drawTakeUse(canvas, wide, readTheme(), useByGroup, laneRows, ctx.s.editor.getState().auditionTake);
}

/** The clips as they will be after the drag in progress, drawn as selected on top of everything. */
function drawPreview(
  ctx: PlaylistContext,
  canvas: CanvasRenderingContext2D,
  wide: Viewport,
  project: Project,
  laneRows: ReadonlyMap<LaneId, number>,
  preview: readonly Clip[],
  parts: Pick<ClipStyle, 'waveform' | 'label'>,
): void {
  const selected = new Set(preview.map((clip) => clip.id));
  drawClips(
    canvas,
    wide,
    readTheme(),
    project,
    preview,
    laneRows,
    {
      selected,
      ...parts,
      automation: (clip) => automationDrawStyle(ctx, clip, project, selected),
      ...audioDrawStyle(ctx, selected),
    },
    mutedLanesOf(project),
  );
}
