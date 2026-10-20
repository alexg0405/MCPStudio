/** The breath markers a vocal cleanup found, drawn over an audio clip's waveform (see `AudioClip.cleanup`). */
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import type { AudioClip, AudioClipChannel } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import { alpha } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import type { ClipBox } from './clip-geometry';
import type { ClipPaint } from './clip-paint';

/** Height of the bar at the top of each marker, px. */
const BAR_HEIGHT = 3;
/** A marker is at least this wide (px) so a short breath still shows. */
const MIN_WIDTH = 2;

/**
 * Draws a translucent band and a bar on top for each breath that will be (solid) or will not be (outlined) turned down.
 * Nothing is drawn for a reversed clip (the markers are on the recording's own timeline) or one with no breaths found.
 */
export function drawBreathMarkers(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  clip: AudioClip,
  channel: AudioClipChannel,
  tempo: TempoMap,
  box: ClipBox,
  paint: ClipPaint,
): void {
  const spans = clip.cleanup?.breaths?.spans;
  const mode = playbackMode(channel);
  if (!spans?.length || mode.reverse) return;
  const left = box.x;
  const right = box.x + box.w;
  for (const span of spans) {
    const x0 = Math.max(left, vp.tickToX(tickAtSourceSeconds(clip, mode, tempo, span.from)));
    const x1 = Math.min(right, vp.tickToX(tickAtSourceSeconds(clip, mode, tempo, span.to)));
    if (x1 < left || x0 > right || x1 - x0 < 0) continue;
    const width = Math.max(MIN_WIDTH, x1 - x0);
    ctx.fillStyle = alpha(paint.ink, span.off ? 0.08 : 0.2);
    ctx.fillRect(x0, box.bodyY, width, box.bodyH);
    ctx.fillStyle = alpha(paint.ink, span.off ? 0.35 : 0.9);
    ctx.fillRect(x0, box.bodyY, width, BAR_HEIGHT);
  }
}
