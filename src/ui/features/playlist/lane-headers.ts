/** The track header column on the left of the playlist: mute light, solo ring, name, and the buttons of take tracks. */
import type { Lane, LaneId } from '@core/model/types';
import { alpha, type TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { FOLD_ZONE, LISTEN_ZONE } from './layout';

/** The mute light: where its centre is (px from the header's left edge) and the size of its parts (px). */
const LIGHT_X = 14;
const LIGHT_RADIUS = 3.5;
const LIGHT_GLOW_RADIUS = 6;
const SOLO_RING_RADIUS = 6.5;
/** Where a track's name starts (px from the left edge); take tracks hang in a little further. */
const NAME_X = 27;
const TAKE_NAME_X = 33;
/** A name ends this far (px) before the right end of the header, or before the track's button when it has one. */
const NAME_END_GAP = 6;
const TAKE_NAME_END_GAP = 2;

/** What the headers show besides the tracks themselves. */
export interface LaneHeaderState {
  /** The tracks that do not play now (muted, or silenced by another track's solo). */
  muted: ReadonlySet<LaneId>;
  /** Take groups whose stack of take lanes is open. */
  openTakes: ReadonlySet<string>;
  /** The track of the take being listened to alone (its speaker button is lit), if any. */
  heardLane: LaneId | null;
}

/** Draws the header column (`width` px wide) for the visible tracks; `lanes[row]` is the track on row `row`. */
export function drawLaneHeaders(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  lanes: readonly Lane[],
  width: number,
  state: LaneHeaderState,
): void {
  ctx.fillStyle = theme.surface2;
  ctx.fillRect(0, 0, width, vp.height);
  const [firstRow, lastRow] = vp.visibleRows();
  ctx.font = `500 11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let row = firstRow; row <= Math.min(lastRow, lanes.length - 1); row++) {
    drawLaneHeader(ctx, vp, theme, lanes[row] as Lane, row, width, state);
  }
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(width - 1, 0, 1, vp.height);
}

function drawLaneHeader(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  lane: Lane,
  row: number,
  width: number,
  state: LaneHeaderState,
): void {
  const y = vp.rowToY(row);
  const height = vp.rowHeight;
  const centerY = y + height / 2;
  if (row % 2) {
    ctx.fillStyle = theme.sheen;
    ctx.fillRect(0, y, width, height);
  }
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, y + height - 1, width, 1);
  const isPlaying = !state.muted.has(lane.id);
  drawMuteLight(ctx, theme, centerY, isPlaying, lane.solo);
  const takes = lane.takes;
  if (takes?.role === 'take') {
    // A take lane hangs under its comp lane: an accent rule on the left, the name indented.
    ctx.fillStyle = alpha(theme.accent, 0.5);
    ctx.fillRect(width - 4, y + 3, 2, height - 7);
  }
  const nameInk = isPlaying ? theme.text : theme.textFaint;
  if (takes?.role === 'comp') {
    drawFoldToggle(ctx, theme, width, centerY, state.openTakes.has(takes.group));
    drawName(ctx, lane.name, nameInk, NAME_X, width - FOLD_ZONE, centerY);
  } else if (takes?.role === 'take') {
    drawSpeaker(ctx, width - LISTEN_ZONE / 2 - 3, centerY, state.heardLane === lane.id, theme);
    drawName(ctx, lane.name, nameInk, TAKE_NAME_X, width - LISTEN_ZONE - TAKE_NAME_END_GAP, centerY);
  } else {
    drawName(ctx, lane.name, nameInk, NAME_X, width - NAME_END_GAP, centerY);
  }
}

/** A track's name from `startX`, shortened to end by `endX`. */
function drawName(ctx: CanvasRenderingContext2D, name: string, ink: string, startX: number, endX: number, centerY: number): void {
  ctx.fillStyle = ink;
  ctx.fillText(name, startX, centerY + 0.5, endX - startX);
}

/** The mute light (lit = playing, with a soft halo); a soloed track also gets a gold ring. */
function drawMuteLight(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  centerY: number,
  isPlaying: boolean,
  isSoloed: boolean | undefined,
): void {
  if (isPlaying) {
    ctx.beginPath();
    ctx.arc(LIGHT_X, centerY, LIGHT_GLOW_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = alpha(theme.ledGlow, 0.35);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(LIGHT_X, centerY, LIGHT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = isPlaying ? theme.led : theme.ledOff;
  ctx.fill();
  if (!isSoloed) return;
  ctx.beginPath();
  ctx.arc(LIGHT_X, centerY, SOLO_RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** The fold toggle at the right end of a comp track: ▸ folded, ▾ open (click it to show or hide the takes). */
function drawFoldToggle(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  width: number,
  centerY: number,
  isOpen: boolean,
): void {
  const centerX = width - FOLD_ZONE / 2 - 1;
  ctx.beginPath();
  if (isOpen) {
    ctx.moveTo(centerX - 4, centerY - 2.5);
    ctx.lineTo(centerX + 4, centerY - 2.5);
    ctx.lineTo(centerX, centerY + 3.5);
  } else {
    ctx.moveTo(centerX - 2.5, centerY - 4);
    ctx.lineTo(centerX + 3.5, centerY);
    ctx.lineTo(centerX - 2.5, centerY + 4);
  }
  ctx.closePath();
  ctx.fillStyle = theme.accent;
  ctx.fill();
}

/** A small speaker (lit while the take is being listened to alone). */
function drawSpeaker(ctx: CanvasRenderingContext2D, cx: number, cy: number, isOn: boolean, theme: TimelineTheme): void {
  ctx.save();
  if (isOn) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(cx - 9, cy - 8, 18, 16, 4);
    ctx.fill();
  }
  const ink = isOn ? theme.surface2 : theme.textFaint;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy - 2);
  ctx.lineTo(cx - 2.5, cy - 2);
  ctx.lineTo(cx + 0.5, cy - 5);
  ctx.lineTo(cx + 0.5, cy + 5);
  ctx.lineTo(cx - 2.5, cy + 2);
  ctx.lineTo(cx - 5, cy + 2);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 0.5, cy, 3.5, -0.9, 0.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 0.5, cy, 6.2, -0.9, 0.9);
  ctx.stroke();
  ctx.restore();
}
