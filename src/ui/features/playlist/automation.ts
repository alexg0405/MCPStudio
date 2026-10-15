/**
 * Automation clips on the playlist: the curve drawn inside the clip, its points and curve handles
 * (shown when the clip is selected or under the pointer), hit testing for inline editing, the value
 * readout shown while dragging, and the hint-bar text for every gesture.
 */
import { curveAt, segmentValue } from '@core/automation/curve';
import type { AutomationChannel, AutomationClip, AutoPoint, Tick } from '@core/model/types';
import { alpha, type TimelineTheme } from '../../timeline/canvas';
import type { ClipPaint } from './clip-paint';
import type { Viewport } from '../../timeline/viewport';
import type { ClipBox } from './clip-geometry';

/** Space between the curve's 0 / 1 and the body's edges. */
const PAD = 3;
/** Bodies lower than this show the curve but can't be edited. */
export const MIN_EDIT_HEIGHT = 12;
const POINT_HIT = 6;
const HANDLE_HIT = 5;

export type AutoHit =
  | { part: 'point'; index: number }
  | { part: 'handle'; index: number }
  | { part: 'curve' }
  /** The track is too low to edit points. */
  | { part: 'small' };

export const AUTO_HINTS = {
  point:
    'Automation point: drag to move it (hold Alt to ignore the grid) · right-click for its shape or to delete it',
  handle: 'Curve handle: drag up or down to bend this part of the curve · double-click to straighten it',
  curve: (label: string) =>
    `Automation clip ‘${label}’: double-click or right-click to add a point · drag to move the clip · right-click its title bar to delete it`,
  title: (label: string) =>
    `Automation clip ‘${label}’: drag to move · drag an edge to resize · ▾ for options (LFO, point shapes…) · right-click to delete`,
  small: 'Make the track taller to edit points: Alt + mouse wheel over the playlist',
};

export const valueToY = (v: number, box: ClipBox): number =>
  box.bodyY + PAD + (1 - v) * Math.max(1, box.bodyH - 2 * PAD);

export const yToValue = (y: number, box: ClipBox): number => {
  const v = 1 - (y - box.bodyY - PAD) / Math.max(1, box.bodyH - 2 * PAD);
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
};

/** Song tick of a content tick of the clip. */
export const contentToTick = (clip: AutomationClip, c: Tick): Tick => clip.start - clip.offset + c;
export const tickToContent = (clip: AutomationClip, tick: Tick): Tick => tick - clip.start + clip.offset;

/** Points inside the part of the curve the clip shows. */
function visible(clip: AutomationClip, p: AutoPoint): boolean {
  return p.tick >= clip.offset && p.tick <= clip.offset + clip.length;
}

/** Average pixels between the clip's visible points. */
function spacingOf(clip: AutomationClip, points: readonly AutoPoint[], box: ClipBox): number {
  let shown = 0;
  for (const p of points) if (visible(clip, p)) shown++;
  return box.w / Math.max(1, shown - 1);
}

/** The curve handle of the segment leaving point `i` (bendable segments only), in content ticks. */
export function handleOf(points: readonly AutoPoint[], i: number): { tick: number; value: number } | null {
  const a = points[i];
  const b = points[i + 1];
  if (!a || !b || (a.shape ?? 'curve') !== 'curve' || a.value === b.value || b.tick <= a.tick) return null;
  const tick = (a.tick + b.tick) / 2;
  return { tick, value: segmentValue(a, b, tick) };
}

/** What's under (x, y) inside an automation clip's body (null in the title bar). */
export function hitAutomation(
  vp: Viewport,
  clip: AutomationClip,
  ch: AutomationChannel,
  box: ClipBox,
  x: number,
  y: number,
): AutoHit | null {
  if (y < box.bodyY - 2 || y > box.bodyY + box.bodyH + 2 || box.bodyH <= 3) return null;
  if (box.bodyH < MIN_EDIT_HEIGHT) return { part: 'small' };
  let best = -1;
  let dist = POINT_HIT;
  ch.points.forEach((p, i) => {
    if (!visible(clip, p)) return;
    const d = Math.hypot(vp.tickToX(contentToTick(clip, p.tick)) - x, valueToY(p.value, box) - y);
    if (d <= dist) {
      dist = d;
      best = i;
    }
  });
  if (best >= 0) return { part: 'point', index: best };
  // Handles show (and can be grabbed) only where points aren't crowded.
  if (spacingOf(clip, ch.points, box) < 14) return { part: 'curve' };
  for (let i = 0; i + 1 < ch.points.length; i++) {
    const h = handleOf(ch.points, i);
    if (!h || h.tick < clip.offset || h.tick > clip.offset + clip.length) continue;
    if (Math.hypot(vp.tickToX(contentToTick(clip, h.tick)) - x, valueToY(h.value, box) - y) <= HANDLE_HIT)
      return { part: 'handle', index: i };
  }
  return { part: 'curve' };
}

export interface AutoDraw {
  /** Points and handles are shown (selected or under the pointer). */
  showPoints: boolean;
  /** The point or handle under the pointer / being dragged. */
  hot: AutoHit | null;
  /** Shown in the body when the curve needs explaining (empty, target deleted). */
  note: string | null;
  noteIsWarning: boolean;
}

/** Draws the curve (filled underneath), and points and handles when asked. */
export function drawAutomationBody(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  clip: AutomationClip,
  ch: AutomationChannel,
  box: ClipBox,
  paint: ClipPaint,
  d: AutoDraw,
): void {
  if (box.bodyH <= 3) return;
  const pts = ch.points;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.bodyY, box.w, box.bodyH);
  ctx.clip();
  const from = Math.max(Math.floor(box.x), 0);
  const to = Math.min(Math.ceil(box.x + box.w), vp.width);
  if (pts.length > 0 && to > from) {
    // One pass for the curve; the same path closed underneath is the soft fill.
    const bottom = box.bodyY + box.bodyH;
    const ys = new Float32Array(to - from + 1);
    for (let px = from; px <= to; px++) ys[px - from] = valueToY(curveAt(pts, tickToContent(clip, vp.xToTick(px))) ?? 0, box);
    ctx.beginPath();
    ctx.moveTo(from, bottom);
    for (let px = from; px <= to; px++) ctx.lineTo(px, ys[px - from] as number);
    ctx.lineTo(to, bottom);
    ctx.closePath();
    ctx.fillStyle = paint.contentFill;
    ctx.fill();
    ctx.beginPath();
    for (let px = from; px <= to; px++) {
      if (px === from) ctx.moveTo(px, ys[0] as number);
      else ctx.lineTo(px, ys[px - from] as number);
    }
    ctx.strokeStyle = paint.content;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  if (d.showPoints && box.bodyH >= MIN_EDIT_HEIGHT) {
    // Dense curves (an LFO zoomed out) show smaller points, or only the one under the pointer.
    const spacing = spacingOf(clip, pts, box);
    const r = spacing < 10 ? 1.75 : 2.5;
    const handles = spacing >= 14;
    for (let i = 0; i + 1 < pts.length; i++) {
      const hot = d.hot?.part === 'handle' && d.hot.index === i;
      if (!handles && !hot) continue;
      const h = handleOf(pts, i);
      if (!h || h.tick < clip.offset || h.tick > clip.offset + clip.length) continue;
      ctx.beginPath();
      ctx.arc(vp.tickToX(contentToTick(clip, h.tick)), valueToY(h.value, box), hot ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = hot ? paint.ink : alpha(paint.ink, 0.6);
      ctx.stroke();
    }
    pts.forEach((p, i) => {
      if (!visible(clip, p)) return;
      const hot = d.hot?.part === 'point' && d.hot.index === i;
      if (spacing < 4 && !hot) return;
      ctx.beginPath();
      ctx.arc(vp.tickToX(contentToTick(clip, p.tick)), valueToY(p.value, box), hot ? 4 : r, 0, Math.PI * 2);
      ctx.fillStyle = paint.ink;
      ctx.fill();
      if (hot) {
        ctx.strokeStyle = theme.select;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    });
  }
  if (d.note && box.w > 90 && box.bodyH >= 12) {
    ctx.font = `10px ${theme.font}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = d.noteIsWarning ? theme.danger : paint.inkSoft;
    const tx = Math.max(box.x, 0) + 6;
    ctx.fillText(d.note, tx, box.bodyY + box.bodyH / 2, Math.max(10, Math.min(box.x + box.w, vp.width) - tx - 4));
  }
  ctx.restore();
}

/** A small value label near (x, y), kept inside the canvas. */
export function drawReadout(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  x: number,
  y: number,
  text: string,
  bounds: { width: number; height: number },
): void {
  ctx.font = `600 11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10;
  const h = 18;
  const left = Math.min(Math.max(2, x + 10), bounds.width - w - 2);
  const top = Math.min(Math.max(2, y - h - 6), bounds.height - h - 2);
  ctx.fillStyle = theme.glass;
  ctx.strokeStyle = theme.accentDim;
  ctx.beginPath();
  ctx.roundRect(left + 0.5, top + 0.5, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.text;
  ctx.fillText(text, left + 5, top + h / 2 + 0.5);
}
