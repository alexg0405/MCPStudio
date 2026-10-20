/**
 * The subtle overlay of an aligned clip: a thin line along the bottom of the waveform that rises where the alignment moved
 * the sound earlier and dips where it moved it later (a faint shade between the line and its baseline), so the musician
 * sees where the clip was changed. The points come with the render (`AlignEdit.warp`, milliseconds on the clip's sample).
 */
import { moveAt } from '@core/audio/align';
import { playbackMode, sourceSecondsAt } from '@core/audio/playback';
import type { AudioClip, AudioClipChannel } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import { alpha } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import type { ClipBox } from './clip-geometry';
import type { ClipPaint } from './clip-paint';

/** A move this large (ms) reaches the full height of the overlay. */
const FULL_SCALE_MS = 150;
/** The overlay never takes more than this share of the body's height, and at most this many px each way. */
const MAX_HEIGHT_SHARE = 0.22;
const MAX_HEIGHT_PX = 14;
/** Clips smaller than this (px) show no overlay. */
const MIN_WIDTH = 40;
const MIN_BODY_HEIGHT = 28;
/** The line is sampled every this many px. */
const STEP_PX = 3;
/** Moves under this (ms) are drawn flat: nothing to see. */
const NEGLIGIBLE_MS = 2;

/** Draws the overlay for an aligned clip that has its points; does nothing otherwise. */
export function drawWarpOverlay(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  clip: AudioClip,
  channel: AudioClipChannel,
  tempo: TempoMap,
  box: ClipBox,
  paint: ClipPaint,
): void {
  const warp = clip.align?.warp;
  if (!warp || warp.length < 4 || box.w < MIN_WIDTH || box.bodyH < MIN_BODY_HEIGHT) return;
  const mode = playbackMode(channel);
  const reach = Math.min(MAX_HEIGHT_PX, box.bodyH * MAX_HEIGHT_SHARE);
  const baseline = box.bodyY + box.bodyH - reach - 3;
  const from = Math.max(box.x, 0);
  const to = Math.min(box.x + box.w, vp.width);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.bodyY, box.w, box.bodyH);
  ctx.clip();
  const points: { x: number; y: number }[] = [];
  for (let x = from; x <= to + STEP_PX; x += STEP_PX) {
    const px = Math.min(x, to);
    const sampleSec = sourceSecondsAt(clip, mode, tempo, vp.xToTick(px));
    const move = moveAt(warp, sampleSec);
    const shown = Math.abs(move) < NEGLIGIBLE_MS ? 0 : move;
    points.push({ x: px, y: baseline - Math.max(-1, Math.min(1, shown / FULL_SCALE_MS)) * reach });
  }
  ctx.fillStyle = alpha(paint.ink, 0.16);
  ctx.beginPath();
  ctx.moveTo(points[0]?.x ?? from, baseline);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1]?.x ?? to, baseline);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = alpha(paint.ink, 0.5);
  ctx.lineWidth = 1;
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  ctx.strokeStyle = alpha(paint.ink, 0.22);
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(from, baseline + 0.5);
  ctx.lineTo(to, baseline + 0.5);
  ctx.stroke();
  ctx.restore();
}
