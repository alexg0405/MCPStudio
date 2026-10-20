/** Where a recording's comp uses each take: shown on the take tracks, so it is plain what plays from where. */
import type { AudioClip, ClipId, LaneId, Tick } from '@core/model/types';
import { alpha, type TimelineTheme, fontPx } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { clipBox, type ClipBox } from './clip-geometry';

/** One recording's takes and the parts of them its comp plays. */
export interface TakeUseGroup {
  /** The take clips, one per take lane (a take can have several when it was split). */
  clips: readonly AudioClip[];
  /** The comp's parts: which take (its index) plays from `from` to `to`. */
  segments: ReadonlyArray<{ take: number; from: Tick; to: Tick }>;
}

/** The "Listening to this take" label is shown only on take clips wider than this (px). */
const MIN_LISTENING_LABEL_CLIP_WIDTH = 90;

/**
 * A lighter band over the used part of each take's clip (on take lanes that are on screen), with an accent edge on top.
 * `heard` is the take clip being listened to alone: it gets an accent outline and a label.
 */
export function drawTakeUse(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  groups: readonly TakeUseGroup[],
  laneIndex: ReadonlyMap<LaneId, number>,
  heard: ClipId | null = null,
): void {
  for (const group of groups) {
    for (const clip of group.clips) {
      const row = laneIndex.get(clip.laneId);
      if (row === undefined || !clip.take) continue;
      const box = clipBox(vp, row, clip);
      if (box.y + box.h < 0 || box.y > vp.height) continue;
      if (clip.id === heard) drawListeningMark(ctx, theme, box);
      for (const segment of group.segments) {
        if (segment.take === clip.take.index) drawUsedPart(ctx, vp, theme, clip, box, segment.from, segment.to);
      }
    }
  }
}

/** The outline and label of the take that is being listened to alone. */
function drawListeningMark(ctx: CanvasRenderingContext2D, theme: TimelineTheme, box: ClipBox): void {
  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
  if (box.w > MIN_LISTENING_LABEL_CLIP_WIDTH) {
    ctx.font = `600 ${fontPx(10)}px ${theme.font}`;
    ctx.textBaseline = 'middle';
    const label = 'Listening to this take';
    const labelWidth = ctx.measureText(label).width + 10;
    ctx.fillStyle = theme.accent;
    ctx.fillRect(box.x + 4, box.bodyY + 3, labelWidth, 14);
    ctx.fillStyle = theme.surface2;
    ctx.fillText(label, box.x + 9, box.bodyY + 10.5);
  }
  ctx.restore();
}

/** The part of a take clip between `from` and `to`, when the comp plays it (if any of it is on screen). */
function drawUsedPart(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  clip: AudioClip,
  box: ClipBox,
  from: Tick,
  to: Tick,
): void {
  const start = Math.max(from, clip.start);
  const end = Math.min(to, clip.start + clip.length);
  if (end <= start) return;
  const x0 = vp.tickToPx(start);
  const x1 = vp.tickToPx(end);
  if (x1 < 0 || x0 > vp.width) return;
  ctx.fillStyle = alpha(theme.accent, 0.3);
  ctx.fillRect(x0, box.bodyY - 1, Math.max(1, x1 - x0), box.bodyH + 2);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(x0, box.y, Math.max(1, x1 - x0), 2);
}
