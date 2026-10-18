/** Marker flags on the ruler (and their hairlines down the tracks), and finding which flag a pointer is on. */
import type { Marker, MarkerId, Tick } from '@core/model/types';
import { alpha, inkOn, mix, roundRectPath, type TimelineTheme } from '../../timeline/canvas';
import { drawStudioMark } from '../../controls/studio-mark';
import type { Viewport } from '../../timeline/viewport';
import { MARKER_ASK_WIDTH, MARKER_LANE_Y, RULER_HEIGHT } from './layout';

/** Where a marker's flag was drawn (hit testing on the ruler). */
export interface MarkerBox {
  id: MarkerId;
  tick: Tick;
  /** Flag and label span in ruler pixels. */
  x0: number;
  x1: number;
  /** The flag's Studio mark (ask the AI about the section), on flags wide enough for it. */
  ask?: { x0: number; x1: number };
}

/** The markers to draw and how: which one is under the pointer or being dragged. */
export interface RulerMarkers {
  markers: readonly Marker[];
  /** The marker under the pointer or being dragged (drawn brighter). */
  hot?: MarkerId | null;
  /** The pointer is on the hot marker's Studio mark. */
  hotAsk?: boolean;
  /** A marker being dragged: drawn at this tick instead. */
  drag?: { id: MarkerId; tick: Tick } | null;
}

/** Height of a marker's pill (px). */
const FLAG_HEIGHT = 13;
/** Room around a flag's name: before the text and after it (px). */
const FLAG_PADDING = 12;
/** A flag is at least this wide (px), even when the next marker is right next to it. */
const MIN_FLAG_WIDTH = 8;
/** Flags narrower than this (px) show no name. */
const MIN_NAMED_FLAG_WIDTH = 14;
/** The flag's pole and its hit box reach this far left of the marker's tick (px). */
const FLAG_LEFT_REACH = 3;

/** Marker positions with a drag applied, sorted. */
export function placedMarkers(markers: RulerMarkers): Marker[] {
  const list = markers.markers.map((m) => (markers.drag?.id === m.id ? { ...m, tick: markers.drag.tick } : m));
  return list.sort((a, b) => a.tick - b.tick);
}

/** A marker's color: its own, or the theme's gold. */
function markerColor(marker: Marker, theme: TimelineTheme): string {
  return /^#[0-9a-f]{6}$/i.test(marker.color ?? '') ? (marker.color as string) : theme.marker;
}

/**
 * Each section (marker to the next one, the last to the song's end) as a very faint band in the marker lane. `bar` is
 * how long (ticks) the last section is when the song is shorter than its marker.
 */
export function drawMarkerSections(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  placed: readonly Marker[],
  songEnd: Tick,
  bar: Tick,
): void {
  for (let i = 0; i < placed.length; i++) {
    const marker = placed[i] as Marker;
    const next = placed[i + 1];
    const x0 = Math.max(0, vp.tickToPx(marker.tick));
    const x1 = Math.min(vp.width, vp.tickToPx(next ? next.tick : Math.max(songEnd, marker.tick + bar)));
    if (x1 <= x0) continue;
    ctx.fillStyle = alpha(markerColor(marker, theme), 0.07);
    ctx.fillRect(x0, MARKER_LANE_Y + 1, x1 - x0, RULER_HEIGHT - MARKER_LANE_Y - 2);
  }
}

/**
 * The flags: a small pill on the marker lane with the name (and a Studio mark when there is room). Returns where each
 * flag is, in the picture's own pixels, for hit testing.
 */
export function drawMarkerFlags(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  markers: RulerMarkers,
  placed: readonly Marker[],
): MarkerBox[] {
  const boxes: MarkerBox[] = [];
  ctx.font = `600 10px ${theme.font}`;
  ctx.textBaseline = 'middle';
  const flagTop = MARKER_LANE_Y + (RULER_HEIGHT - MARKER_LANE_Y - FLAG_HEIGHT) / 2;
  const centerY = flagTop + FLAG_HEIGHT / 2;
  for (let i = 0; i < placed.length; i++) {
    const marker = placed[i] as Marker;
    const next = placed[i + 1];
    const x = vp.tickToPx(marker.tick);
    const textWidth = ctx.measureText(marker.name).width;
    // The last flag takes the room its text needs (not the view's edge: the picture is drawn wider than the view).
    const room = next ? vp.tickToPx(next.tick) - 2 : x + textWidth + FLAG_PADDING + MARKER_ASK_WIDTH;
    const hasAskMark = room - x >= textWidth + FLAG_PADDING + MARKER_ASK_WIDTH;
    const wanted = x + textWidth + FLAG_PADDING + (hasAskMark ? MARKER_ASK_WIDTH : 0);
    const x1 = Math.max(x + MIN_FLAG_WIDTH, Math.min(room, wanted));
    boxes.push({
      id: marker.id,
      tick: marker.tick,
      x0: x - FLAG_LEFT_REACH,
      x1,
      ...(hasAskMark ? { ask: { x0: x1 - MARKER_ASK_WIDTH, x1 } } : {}),
    });
    if (x1 < 0 || x - FLAG_LEFT_REACH > vp.width) continue;
    drawFlag(ctx, theme, marker, markers, { x, x1, flagTop, centerY, hasAskMark });
  }
  return boxes;
}

/** Where one flag goes (ruler px). */
interface FlagPlace {
  x: number;
  x1: number;
  flagTop: number;
  centerY: number;
  hasAskMark: boolean;
}

function drawFlag(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  marker: Marker,
  markers: RulerMarkers,
  place: FlagPlace,
): void {
  const { x, x1, flagTop, centerY, hasAskMark } = place;
  const color = markerColor(marker, theme);
  const isHot = markers.hot === marker.id || markers.drag?.id === marker.id;
  const fill = isHot ? mix(color, theme.text, 0.82) : color;
  const ink = inkOn(fill, theme);
  // The flag's pole: a hairline from the pill to the lane's bottom edge.
  ctx.fillStyle = color;
  ctx.fillRect(x, MARKER_LANE_Y, 1, RULER_HEIGHT - MARKER_LANE_Y);
  ctx.beginPath();
  roundRectPath(ctx, x, flagTop, Math.max(4, x1 - x), FLAG_HEIGHT, FLAG_HEIGHT / 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (x1 - x > MIN_NAMED_FLAG_WIDTH) {
    ctx.fillStyle = ink;
    ctx.fillText(marker.name, x + 6, centerY + 0.5, x1 - x - 9 - (hasAskMark ? MARKER_ASK_WIDTH : 0));
  }
  if (!hasAskMark) return;
  const markX = x1 - MARKER_ASK_WIDTH;
  const isAskHot = markers.hot === marker.id && markers.hotAsk;
  if (isAskHot) {
    ctx.beginPath();
    ctx.arc(markX + 6.5, centerY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = alpha(ink, 0.16);
    ctx.fill();
  }
  ctx.strokeStyle = isAskHot ? ink : alpha(ink, isHot ? 0.8 : 0.5);
  drawStudioMark(ctx, markX + 6.5, centerY, 10);
}

/** The marker whose flag is at ruler x (the last drawn wins where they touch). */
export function markerAtX(boxes: readonly MarkerBox[], x: number): MarkerBox | null {
  let hit: MarkerBox | null = null;
  for (const box of boxes) if (x >= box.x0 && x < box.x1) hit = box;
  return hit;
}

/** Hairlines down the tracks where markers are. */
export function drawMarkerLines(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  markers: RulerMarkers,
  theme: TimelineTheme,
): void {
  for (const marker of placedMarkers(markers)) {
    const x = vp.tickToPx(marker.tick);
    if (x < 0 || x > vp.width) continue;
    ctx.fillStyle = alpha(markerColor(marker, theme), 0.3);
    ctx.fillRect(x, 0, 1, vp.height);
  }
}
