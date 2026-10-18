/** The playlist's ruler: bar numbers on top, the loop and punch ranges, and the marker lane below. */
import type { TimeSignature, Tick } from '@core/model/types';
import { ticksPerBar, ticksPerBeat } from '@core/time/ppq';
import { alpha, roundRectPath, type TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { MARKER_LANE_Y, RULER_HEIGHT } from './layout';
import { drawMarkerFlags, drawMarkerSections, placedMarkers, type MarkerBox, type RulerMarkers } from './marker-flags';

/** What the ruler shows. */
export interface RulerContent {
  timeSig: TimeSignature;
  /** The loop region, drawn as a soft gold band behind the bar numbers. */
  loop: { start: Tick; end: Tick } | null;
  /** The punch range audio recording keeps, drawn as a red band with In and Out ends. */
  punch: { start: Tick; end: Tick } | null;
  /** Where the song ends (0: nowhere yet), drawn as a line. */
  songEnd: Tick;
  markers: RulerMarkers;
}

/** Beat ticks are drawn when beats are at least this far apart (px). */
const MIN_BEAT_TICK_PX = 10;
/** The punch range's "OUT" label needs a range at least this wide (px). */
const MIN_PUNCH_LABEL_RANGE_PX = 40;

/**
 * Draws the ruler for the viewport. Returns where each marker flag landed (in the picture's own pixels), which the
 * controller keeps for hit testing.
 */
export function drawPlaylistRuler(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  content: RulerContent,
): MarkerBox[] {
  drawBackground(ctx, vp, theme);
  if (content.loop) drawLoopBand(ctx, vp, theme, content.loop);
  if (content.punch) drawPunchBand(ctx, vp, theme, content.punch);
  drawBarMarks(ctx, vp, theme, content.timeSig);
  if (content.songEnd > 0) drawSongEnd(ctx, vp, theme, content.songEnd);
  const placed = placedMarkers(content.markers);
  drawMarkerSections(ctx, vp, theme, placed, content.songEnd, ticksPerBar(content.timeSig));
  const boxes = drawMarkerFlags(ctx, vp, theme, content.markers, placed);
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, RULER_HEIGHT - 1, vp.width, 1);
  return boxes;
}

function drawBackground(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme): void {
  ctx.fillStyle = theme.surface2;
  ctx.fillRect(0, 0, vp.width, RULER_HEIGHT);
  // The marker lane sits a touch deeper.
  ctx.fillStyle = theme.sheen;
  ctx.fillRect(0, MARKER_LANE_Y, vp.width, RULER_HEIGHT - MARKER_LANE_Y);
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, MARKER_LANE_Y, vp.width, 1);
}

/** The loop: a soft gold band with rounded ends behind the bar numbers. */
function drawLoopBand(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, loop: { start: Tick; end: Tick }): void {
  const x0 = vp.tickToPx(loop.start);
  const x1 = vp.tickToPx(loop.end);
  const bandHeight = MARKER_LANE_Y - 5;
  ctx.beginPath();
  roundRectPath(ctx, x0 + 0.5, 2.5, Math.max(1, x1 - x0 - 1), bandHeight, bandHeight / 2);
  ctx.fillStyle = theme.accentSoft;
  ctx.fill();
  ctx.strokeStyle = alpha(theme.accent, 0.55);
  ctx.stroke();
}

/** The punch range: a red band along the bottom of the bar-number row, with In and Out ends. */
function drawPunchBand(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, punch: { start: Tick; end: Tick }): void {
  const x0 = vp.tickToPx(punch.start);
  const x1 = vp.tickToPx(punch.end);
  ctx.fillStyle = alpha(theme.danger, 0.22);
  ctx.fillRect(x0, MARKER_LANE_Y - 6, Math.max(1, x1 - x0), 6);
  ctx.fillStyle = theme.danger;
  ctx.fillRect(x0, 0, 2, MARKER_LANE_Y);
  ctx.fillRect(x1 - 2, 0, 2, MARKER_LANE_Y);
  ctx.font = `700 8px ${theme.font}`;
  ctx.textBaseline = 'top';
  ctx.fillText('IN', x0 + 4, 12);
  if (x1 - x0 > MIN_PUNCH_LABEL_RANGE_PX) ctx.fillText('OUT', x1 - 24, 12);
}

/** Every how many bars a number is written: all of them when there is room, fewer as the view zooms out. */
function barLabelInterval(barWidthPx: number): number {
  if (barWidthPx >= 36) return 1;
  if (barWidthPx >= 18) return 2;
  if (barWidthPx >= 9) return 4;
  return 8;
}

/** Hairline ticks: beats short, bars longer, numbered bars longest, with the bar numbers. */
function drawBarMarks(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, timeSig: TimeSignature): void {
  const bar = ticksPerBar(timeSig);
  const beat = ticksPerBeat(timeSig);
  const [firstTick, lastTick] = vp.visibleTicks();
  const labelEvery = barLabelInterval(bar * vp.pxPerTick);
  if (beat * vp.pxPerTick >= MIN_BEAT_TICK_PX) {
    ctx.fillStyle = theme.lineFaint;
    for (let tick = Math.floor(firstTick / beat) * beat; tick <= lastTick; tick += beat) {
      if (tick % bar !== 0) ctx.fillRect(vp.tickToPx(tick), MARKER_LANE_Y - 3, 1, 3);
    }
  }
  ctx.font = `500 10px ${theme.font}`;
  ctx.textBaseline = 'top';
  const numberedTick = alpha(theme.textFaint, 0.6);
  for (let barIndex = Math.floor(firstTick / bar); barIndex * bar <= lastTick; barIndex++) {
    const x = vp.tickToPx(barIndex * bar);
    const isNumbered = barIndex % labelEvery === 0;
    const tickHeight = isNumbered ? 7 : 4;
    ctx.fillStyle = isNumbered ? numberedTick : theme.lineFaint;
    ctx.fillRect(x, MARKER_LANE_Y - tickHeight, 1, tickHeight);
    if (!isNumbered) continue;
    ctx.fillStyle = theme.textFaint;
    ctx.fillText(String(barIndex + 1), x + 3, 3);
  }
}

/** A line where the song ends (when that is in view). */
function drawSongEnd(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, songEnd: Tick): void {
  const x = vp.tickToPx(songEnd);
  if (x < 0 || x > vp.width) return;
  ctx.fillStyle = alpha(theme.textFaint, 0.7);
  ctx.fillRect(x, 0, 1, RULER_HEIGHT);
}
