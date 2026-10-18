/**
 * Stereo drawing for the Meters window: the goniometer (vectorscope) and the bars for correlation and for the width of
 * the low, mid and high band. Both read the shared memory of the meter and draw straight to a canvas.
 */
import type { MeterHandle } from '@engine/api';
import { R, SCOPE_FRAMES } from '@engine/meter/layout';
import { alpha, type TimelineTheme } from '../../timeline/canvas';
import { correlationText, widthText } from './meters-model';

/** Frames of the scope ring drawn as dots (the newest ones). */
const SCOPE_DOTS = 1024;
/** Full-scale mono reaches this share of the half-size of the scope. */
const SCOPE_GAIN = 0.7;
const BAR_LABEL_WIDTH = 74;
const BAR_VALUE_WIDTH = 44;
const BAR_HEIGHT = 10;

/** The goniometer: mono is a vertical line, left only leans left, out of phase is a horizontal line. */
export function drawGoniometer(g: CanvasRenderingContext2D, width: number, height: number, theme: TimelineTheme, meter: MeterHandle, showDots: boolean): void {
  g.clearRect(0, 0, width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(centerX, centerY) - 14;
  g.strokeStyle = theme.lineFaint;
  g.fillStyle = theme.textFaint;
  g.lineWidth = 1;
  g.font = `500 10px ${theme.font}`;
  g.beginPath();
  g.arc(centerX, centerY, radius, 0, Math.PI * 2);
  g.moveTo(centerX, centerY - radius);
  g.lineTo(centerX, centerY + radius);
  g.moveTo(centerX - radius, centerY);
  g.lineTo(centerX + radius, centerY);
  g.moveTo(centerX - radius * 0.7071, centerY + radius * 0.7071);
  g.lineTo(centerX + radius * 0.7071, centerY - radius * 0.7071);
  g.moveTo(centerX - radius * 0.7071, centerY - radius * 0.7071);
  g.lineTo(centerX + radius * 0.7071, centerY + radius * 0.7071);
  g.stroke();
  g.textAlign = 'center';
  g.fillText('mono', centerX, centerY - radius - 3);
  g.fillText('L', centerX - radius * 0.7071 - 7, centerY - radius * 0.7071 + 3);
  g.fillText('R', centerX + radius * 0.7071 + 7, centerY - radius * 0.7071 + 3);
  g.textAlign = 'left';
  if (!showDots) return;
  const scale = radius * SCOPE_GAIN;
  const newest = meter.readings[R.scopePos] as number;
  g.fillStyle = alpha(theme.accentLight, 0.55);
  for (let i = 0; i < SCOPE_DOTS; i++) {
    const at = ((newest - SCOPE_DOTS + i + SCOPE_FRAMES) % SCOPE_FRAMES) * 2;
    const left = meter.scope[at] as number;
    const right = meter.scope[at + 1] as number;
    g.fillRect(centerX + (right - left) * scale - 0.75, centerY - (left + right) * scale - 0.75, 1.5, 1.5);
  }
}

function drawLabel(g: CanvasRenderingContext2D, theme: TimelineTheme, text: string, y: number, valueText: string, width: number): void {
  g.fillStyle = theme.textDim;
  g.textAlign = 'left';
  g.fillText(text, 0, y + BAR_HEIGHT - 1);
  g.fillStyle = theme.text;
  g.textAlign = 'right';
  g.fillText(valueText, width, y + BAR_HEIGHT - 1);
  g.textAlign = 'left';
}

/** The correlation bar: from −1 (red, opposite) through 0 to +1 (mono), the fill growing from the middle. */
function drawCorrelationBar(g: CanvasRenderingContext2D, width: number, y: number, theme: TimelineTheme, correlation: number): void {
  const x0 = BAR_LABEL_WIDTH;
  const trackWidth = width - BAR_LABEL_WIDTH - BAR_VALUE_WIDTH;
  const middle = x0 + trackWidth / 2;
  g.fillStyle = theme.surfaceInset;
  g.fillRect(x0, y, trackWidth, BAR_HEIGHT);
  g.fillStyle = correlation < 0 ? theme.danger : correlation < 0.3 ? theme.meterMid : theme.meterLo;
  g.fillRect(Math.min(middle, middle + (correlation * trackWidth) / 2), y, Math.abs((correlation * trackWidth) / 2), BAR_HEIGHT);
  g.fillStyle = theme.textDim;
  g.fillRect(middle - 0.5, y - 2, 1, BAR_HEIGHT + 4);
}

function drawWidthBar(g: CanvasRenderingContext2D, width: number, y: number, theme: TimelineTheme, share: number): void {
  const x0 = BAR_LABEL_WIDTH;
  const trackWidth = width - BAR_LABEL_WIDTH - BAR_VALUE_WIDTH;
  g.fillStyle = theme.surfaceInset;
  g.fillRect(x0, y, trackWidth, BAR_HEIGHT);
  g.fillStyle = share > 0.75 ? theme.danger : theme.accent;
  g.fillRect(x0, y, trackWidth * Math.max(0, Math.min(1, share)), BAR_HEIGHT);
}

/** Row height of the bars canvas, so the window can size it. */
export const STEREO_BARS_HEIGHT = 4 * 22;

/** Correlation and the three widths as labelled bars. */
export function drawStereoBars(g: CanvasRenderingContext2D, width: number, height: number, theme: TimelineTheme, meter: MeterHandle): void {
  g.clearRect(0, 0, width, height);
  g.font = `500 11px ${theme.font}`;
  const r = meter.readings;
  const correlation = r[R.correlation] as number;
  drawLabel(g, theme, 'Correlation', 4, correlationText(correlation), width);
  drawCorrelationBar(g, width, 4, theme, correlation);
  const widths: [string, number][] = [
    ['Width low', r[R.widthLow] as number],
    ['Width mid', r[R.widthMid] as number],
    ['Width high', r[R.widthHigh] as number],
  ];
  widths.forEach(([label, share], row) => {
    const y = 4 + (row + 1) * 22;
    drawLabel(g, theme, label, y, widthText(share), width);
    drawWidthBar(g, width, y, theme, share);
  });
}
