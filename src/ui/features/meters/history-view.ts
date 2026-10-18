/**
 * The loudness history graph: momentary (thin) and short-term (bold) loudness since the last restart, with the target
 * as a dashed line. The audio thread writes a point every 100 ms while there is sound; the graph shows all of them,
 * squeezing older time together once more than a minute has passed.
 */
import type { MeterHandle } from '@engine/api';
import { HISTORY_CAPACITY, R } from '@app/metering/layout';
import { alpha, type TimelineTheme } from '../../timeline/canvas';
import { lufsText } from './meters-model';

const TOP_LUFS = 0;
const BOTTOM_LUFS = -60;
/** The graph is at least this wide in time before it starts to squeeze (points: 100 ms each = one minute). */
const MIN_SPAN_POINTS = 600;
const GRID_STEP_LU = 10;

const levelY = (lufs: number, height: number) =>
  ((TOP_LUFS - Math.min(TOP_LUFS, Math.max(BOTTOM_LUFS, lufs))) / (TOP_LUFS - BOTTOM_LUFS)) * height;

/** Points written since the last restart (and the first one still kept), as the shared ring holds them. */
function pointRange(meter: MeterHandle): { first: number; count: number } {
  const written = meter.readings[R.histCount] as number;
  const restart = meter.readings[R.histStart] as number;
  const first = Math.max(restart, written - HISTORY_CAPACITY);
  return { first, count: Math.max(0, written - first) };
}

/** How many points the graph has (the window uses it to tell the empty graph from a drawn one). */
export function historyLength(meter: MeterHandle): number {
  return pointRange(meter).count;
}

function drawGrid(g: CanvasRenderingContext2D, width: number, height: number, theme: TimelineTheme): void {
  g.font = `500 10px ${theme.font}`;
  g.fillStyle = theme.textFaint;
  g.strokeStyle = theme.lineFaint;
  g.lineWidth = 1;
  for (let lufs = TOP_LUFS - GRID_STEP_LU; lufs > BOTTOM_LUFS; lufs -= GRID_STEP_LU) {
    const y = Math.round(levelY(lufs, height)) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y);
    g.stroke();
    g.fillText(`${lufsText(lufs)}`, 3, y - 3);
  }
}

function traceHistory(g: CanvasRenderingContext2D, width: number, height: number, meter: MeterHandle, channel: 0 | 1, from: number, count: number): void {
  const span = Math.max(MIN_SPAN_POINTS, count);
  const stride = Math.max(1, Math.floor(count / Math.max(1, width)));
  g.beginPath();
  for (let i = 0; i < count; i += stride) {
    const at = ((from + i) % HISTORY_CAPACITY) * 2 + channel;
    const x = (i / span) * width;
    const y = levelY(meter.history[at] as number, height);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/** Draws the graph; `target` is the target line in LUFS (null: none), `targetLabel` says where it comes from. */
export function drawHistory(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: TimelineTheme,
  meter: MeterHandle,
  target: { lufs: number | null; label: string },
): void {
  g.clearRect(0, 0, width, height);
  drawGrid(g, width, height, theme);
  if (target.lufs !== null) {
    const y = Math.round(levelY(target.lufs, height)) + 0.5;
    g.save();
    g.strokeStyle = theme.select;
    g.lineWidth = 1;
    g.setLineDash([6, 4]);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y);
    g.stroke();
    g.restore();
    g.fillStyle = theme.select;
    g.textAlign = 'right';
    g.fillText(`${target.label}: ${lufsText(target.lufs)} LUFS`, width - 6, y - 4);
    g.textAlign = 'left';
  }
  const { first, count } = pointRange(meter);
  if (count < 2) return;
  g.lineJoin = 'round';
  g.strokeStyle = alpha(theme.text, 0.35);
  g.lineWidth = 1;
  traceHistory(g, width, height, meter, 0, first, count);
  g.strokeStyle = theme.accent;
  g.lineWidth = 2;
  traceHistory(g, width, height, meter, 1, first, count);
}
