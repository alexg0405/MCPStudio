/** The grid behind the clips: alternating bar bands, track separators, beat lines and bar lines. */
import type { TimeSignature } from '@core/model/types';
import { ticksPerBar, ticksPerBeat } from '@core/time/ppq';
import type { TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';

/** Bars narrower than this (px) are shaded in groups of four, so the bands stay readable when zoomed out. */
const MIN_BAR_BAND_PX = 6;
const BARS_PER_GROUP = 4;
/** Beat lines are left out when beats are closer together than this (px). */
const MIN_BEAT_LINE_PX = 8;

/** Draws the whole grid for the viewport (the layer is redrawn only when something changed, not every frame). */
export function drawLanesGrid(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  timeSig: TimeSignature,
  laneCount: number,
): void {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, vp.width, vp.height);
  const bar = ticksPerBar(timeSig);
  const beat = ticksPerBeat(timeSig);
  const [firstTick, lastTick] = vp.visibleTicks();
  // Every other bar (or group of four when zoomed out) is a shade different: calm stone, easy to count.
  const bandTicks = bar * vp.pxPerTick >= MIN_BAR_BAND_PX ? bar : bar * BARS_PER_GROUP;
  shadeOddBands(ctx, vp, theme, bandTicks, firstTick, lastTick);
  drawTrackSeparators(ctx, vp, theme, laneCount);
  if (beat * vp.pxPerTick >= MIN_BEAT_LINE_PX) drawBeatLines(ctx, vp, theme, beat, bandTicks, firstTick, lastTick);
  drawBandLines(ctx, vp, theme, bandTicks, firstTick, lastTick);
  shadeBelowLastTrack(ctx, vp, theme, laneCount);
}

/** The odd bands (the second, fourth, ...) in a slightly different shade. */
function shadeOddBands(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  bandTicks: number,
  firstTick: number,
  lastTick: number,
): void {
  ctx.fillStyle = theme.bgAlt;
  for (let tick = Math.floor(firstTick / bandTicks) * bandTicks; tick <= lastTick; tick += bandTicks) {
    if ((tick / bandTicks) % 2 !== 1) continue;
    const x = vp.tickToPx(tick);
    ctx.fillRect(x, 0, vp.tickToPx(tick + bandTicks) - x, vp.height);
  }
}

/** A hairline under each track. */
function drawTrackSeparators(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, laneCount: number): void {
  const [firstRow, lastRow] = vp.visibleRows();
  ctx.fillStyle = theme.beat;
  for (let row = firstRow; row <= Math.min(lastRow, laneCount - 1); row++) {
    ctx.fillRect(0, vp.snap(vp.rowToY(row) + vp.rowHeight - 1), vp.width, 1);
  }
}

/** A faint line at each beat that is not on a band line. */
function drawBeatLines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  beatTicks: number,
  bandTicks: number,
  firstTick: number,
  lastTick: number,
): void {
  ctx.fillStyle = theme.beat;
  for (let tick = Math.floor(firstTick / beatTicks) * beatTicks; tick <= lastTick; tick += beatTicks) {
    if (tick % bandTicks !== 0) ctx.fillRect(vp.tickToPx(tick), 0, 1, vp.height);
  }
}

/** A stronger line at the start of each band (each bar, or group of bars). */
function drawBandLines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  bandTicks: number,
  firstTick: number,
  lastTick: number,
): void {
  ctx.fillStyle = theme.bar;
  for (let tick = Math.floor(firstTick / bandTicks) * bandTicks; tick <= lastTick; tick += bandTicks) {
    ctx.fillRect(vp.tickToPx(tick), 0, 1, vp.height);
  }
}

/** The empty area under the last track is darker. */
function shadeBelowLastTrack(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, laneCount: number): void {
  const lanesEnd = vp.snap(vp.rowToY(laneCount));
  if (lanesEnd >= vp.height) return;
  ctx.fillStyle = theme.shade;
  ctx.fillRect(0, lanesEnd, vp.width, vp.height - lanesEnd);
}
