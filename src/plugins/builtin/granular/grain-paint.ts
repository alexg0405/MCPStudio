import type { AudioTap } from '@agstudio/sdk';
import type { ThemeColors } from '@agstudio/sdk/ui';
import { TELEMETRY_GRAINS } from './params';

/** Canvas size in device pixels (drawn at twice its CSS size so lines stay sharp on retina screens). */
export const CANVAS_W = 1200;
export const CANVAS_H = 300;
const DOT_RADIUS = 7;
/** Space kept free above and below the waveform and the grain dots, pixels. */
const WAVEFORM_MARGIN = 6;
const DOT_MARGIN = 20;
const SPRAY_WINDOW_ALPHA = 0.16;
const POSITION_LINE_WIDTH = 3;

/** The sample's peaks for drawing: min and max per bucket, interleaved. */
export interface Peaks {
  peaks: Float32Array;
}

/** Draws the waveform once into a picture that each frame then copies (so a frame costs a few draw calls). */
export function paintWaveform(canvas: HTMLCanvasElement, peaks: Peaks | null, colors: ThemeColors): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = colors.well;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = colors.lineStrong;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H / 2);
  ctx.lineTo(CANVAS_W, CANVAS_H / 2);
  ctx.stroke();
  if (!peaks) return;
  const buckets = peaks.peaks.length >> 1;
  ctx.fillStyle = colors.textFaint;
  for (let x = 0; x < CANVAS_W; x++) {
    const firstBucket = Math.floor((x / CANVAS_W) * buckets);
    const endBucket = Math.max(firstBucket + 1, Math.floor(((x + 1) / CANVAS_W) * buckets));
    let lowest = 0;
    let highest = 0;
    for (let b = firstBucket; b < Math.min(endBucket, buckets); b++) {
      lowest = Math.min(lowest, peaks.peaks[b * 2] as number);
      highest = Math.max(highest, peaks.peaks[b * 2 + 1] as number);
    }
    const top = CANVAS_H / 2 - highest * (CANVAS_H / 2 - WAVEFORM_MARGIN);
    const bottom = CANVAS_H / 2 - lowest * (CANVAS_H / 2 - WAVEFORM_MARGIN);
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

/** The shaded band of positions the spray lets grains start from (it wraps around the ends, as the grains do). */
export function paintSprayWindow(ctx: CanvasRenderingContext2D, colors: ThemeColors, position: number, spray: number) {
  ctx.fillStyle = colors.accentLight;
  ctx.globalAlpha = SPRAY_WINDOW_ALPHA;
  const left = (position - spray) * CANVAS_W;
  const width = Math.min(2 * spray, 1) * CANVAS_W;
  ctx.fillRect(left, 0, width, CANVAS_H);
  if (left < 0) ctx.fillRect(left + CANVAS_W, 0, -left, CANVAS_H);
  if (left + width > CANVAS_W) ctx.fillRect(0, 0, left + width - CANVAS_W, CANVAS_H);
  ctx.globalAlpha = 1;
}

/** The vertical line at the grain position. */
export function paintPositionLine(ctx: CanvasRenderingContext2D, colors: ThemeColors, position: number) {
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = POSITION_LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(position * CANVAS_W, 0);
  ctx.lineTo(position * CANVAS_W, CANVAS_H);
  ctx.stroke();
}

/**
 * One dot per grain that is sounding: further right = further into the sample, higher = further right in the stereo
 * field, brighter = further through the grain's fade.
 */
export function paintGrains(ctx: CanvasRenderingContext2D, colors: ThemeColors, tap: AudioTap) {
  for (let i = 0; i < TELEMETRY_GRAINS; i++) {
    const where = tap.reading(`gp${i}`);
    if (where === undefined || where < 0) continue;
    const through = tap.reading(`gq${i}`) ?? 0;
    const pan = tap.reading(`gx${i}`) ?? 0;
    ctx.globalAlpha = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, through)));
    ctx.fillStyle = colors.select;
    ctx.beginPath();
    ctx.arc(where * CANVAS_W, CANVAS_H / 2 - pan * (CANVAS_H / 2 - DOT_MARGIN), DOT_RADIUS, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
