/** The take being recorded, drawn on the overlay while it grows: a red clip with its waveform so far. */
import type { LiveTake } from '@app/audio-recorder';
import { tempoMapOf } from '@core/automation/tempo';
import type { LaneId, Project } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import { alpha, inkOn, mix, roundRectPath, type TimelineTheme } from '../../../timeline/canvas';
import type { Viewport } from '../../../timeline/viewport';
import { CLIP_RADIUS } from '../clip-geometry';
import type { PlaylistContext } from './context';
import { currentProject, shownLaneOrder } from './lanes';

/** The recording clip is at least this wide (px), so it shows the moment recording starts. */
const MIN_WIDTH = 2;
/** The red title strip's height (px). */
const TITLE_HEIGHT = 13;
/** The waveform starts this far (px) from the clip's top, and leaves this much room (px) around itself in the body. */
const BODY_TOP = 14;
const BODY_VERTICAL_GAPS = 16;
/** A body shorter than this (px) shows no waveform. */
const MIN_WAVEFORM_HEIGHT = 4;

/**
 * Draws the take being recorded. Runs every frame while recording (the overlay is redrawn each frame then), so it keeps
 * the waveform loop free of allocation.
 */
export function drawLiveTake(ctx: PlaylistContext, canvas: CanvasRenderingContext2D, live: LiveTake, theme: TimelineTheme): void {
  const { vp } = ctx;
  const project = currentProject(ctx);
  const x0 = vp.tickToPx(live.start);
  const x1 = Math.max(x0 + MIN_WIDTH, vp.tickToPx(Math.max(live.start, live.now)));
  const y = liveTakeTop(ctx, project, live);
  const height = vp.rowHeight - 2;
  if (x1 < 0 || x0 > vp.width || y > vp.height || y + height < 0) return;
  drawFrame(canvas, theme, x0, x1, y, height);
  const tempo = tempoMapOf(project, 'song');
  const seconds = Math.max(0, tempo.tickToSeconds(live.now) - tempo.tickToSeconds(live.start));
  canvas.font = `600 10px ${theme.font}`;
  canvas.textBaseline = 'middle';
  canvas.fillStyle = inkOn(theme.danger, theme);
  canvas.fillText(`● Recording… ${seconds.toFixed(1)} s`, x0 + 4, y + 7, Math.max(0, x1 - x0 - 8));
  drawWaveform(canvas, vp, theme, tempo, live, x0, x1, y + BODY_TOP, height - BODY_VERTICAL_GAPS);
}

/** The top of the clip: on the track the take is recorded to (`live.lane` counts every track, folded take tracks too). */
function liveTakeTop(ctx: PlaylistContext, project: Project, live: LiveTake): number {
  const order = shownLaneOrder(ctx, project);
  const row = order.indexOf(project.playlist.laneOrder[live.lane] as LaneId);
  return ctx.vp.rowToY(row < 0 ? Math.min(live.lane, order.length) : row) + 1;
}

/** The red clip: a translucent fill, a stronger title strip, an outline. */
function drawFrame(canvas: CanvasRenderingContext2D, theme: TimelineTheme, x0: number, x1: number, y: number, height: number): void {
  const width = x1 - x0;
  canvas.beginPath();
  roundRectPath(canvas, x0, y, width, height, CLIP_RADIUS);
  canvas.fillStyle = alpha(theme.danger, 0.24);
  canvas.fill();
  canvas.save();
  canvas.clip();
  canvas.fillStyle = alpha(theme.danger, 0.8);
  canvas.fillRect(x0, y, width, Math.min(TITLE_HEIGHT, height));
  canvas.restore();
  canvas.strokeStyle = theme.danger;
  canvas.beginPath();
  roundRectPath(canvas, x0 + 0.5, y + 0.5, width - 1, height - 1, CLIP_RADIUS);
  canvas.stroke();
}

/**
 * The peaks recorded so far, one pixel column at a time, in the body from `bodyY` down `bodyHeight` px. (Plain numbers
 * rather than a box object: this runs every frame while recording.)
 */
function drawWaveform(
  canvas: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  tempo: TempoMap,
  live: LiveTake,
  x0: number,
  x1: number,
  bodyY: number,
  bodyHeight: number,
): void {
  const capture = live.capture;
  if (bodyHeight < MIN_WAVEFORM_HEIGHT || capture.buckets === 0) return;
  const middle = bodyY + bodyHeight / 2;
  const startSeconds = tempo.tickToSeconds(live.start);
  canvas.fillStyle = mix(theme.danger, theme.text, 0.35);
  for (let px = Math.max(0, Math.floor(x0)); px < Math.min(vp.width, x1); px++) {
    const fromFrame = live.startFrame + (tempo.tickToSeconds(vp.xToTick(px)) - startSeconds) * capture.sampleRate;
    const toFrame = live.startFrame + (tempo.tickToSeconds(vp.xToTick(px + 1)) - startSeconds) * capture.sampleRate;
    const firstBucket = Math.max(0, Math.floor(fromFrame / capture.bucket));
    const lastBucket = Math.min(capture.buckets, Math.max(firstBucket + 1, Math.ceil(toFrame / capture.bucket)));
    let lowest = 0;
    let highest = 0;
    for (let bucket = firstBucket; bucket < lastBucket; bucket++) {
      lowest = Math.min(lowest, capture.peaks[bucket * 2] as number);
      highest = Math.max(highest, capture.peaks[bucket * 2 + 1] as number);
    }
    const top = Math.max(bodyY, middle - highest * (bodyHeight / 2));
    const bottom = Math.min(bodyY + bodyHeight, middle - lowest * (bodyHeight / 2));
    canvas.fillRect(px, top, 1, Math.max(1, bottom - top));
  }
}
