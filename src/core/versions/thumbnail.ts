/**
 * A small picture of a song's arrangement for the project list: one thin row per playlist track, with a mark wherever a
 * clip plays. Made once from the project's playlist and kept as a few numbers (cached with the project's card), then
 * drawn the same way every time (`thumbnailRects` is plain geometry, so the drawing is the same on every screen).
 */
import type { Clip, Project } from '../model/types';
import { songLength } from '../query/playlist';

/** One track of the thumbnail: its colour and where clips play, as [start, end] column pairs (end excluded). */
export interface ThumbnailRow {
  /** A CSS colour, or null to use the app's accent. */
  color: string | null;
  /** start0, end0, start1, end1, … in columns, sorted and not touching. */
  spans: number[];
}

/** The cached picture: the song cut into `columns` equal slices, and the tracks that play. */
export interface Thumbnail {
  v: 1;
  columns: number;
  rows: ThumbnailRow[];
}

/** How many slices the song is cut into: enough to see the sections of a song, small enough to store. */
export const THUMBNAIL_COLUMNS = 96;
/** The most tracks shown (a busier project shows the tracks with the most to see). */
export const THUMBNAIL_MAX_ROWS = 12;

/** Adds [start, end) to a sorted, non-touching span list, merging what it meets. */
function addSpan(spans: number[], start: number, end: number): void {
  const merged: number[] = [];
  let from = start;
  let to = end;
  for (let i = 0; i < spans.length; i += 2) {
    const a = spans[i] as number;
    const b = spans[i + 1] as number;
    if (b < from || a > to) {
      merged.push(a, b);
      continue;
    }
    from = Math.min(from, a);
    to = Math.max(to, b);
  }
  merged.push(from, to);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < merged.length; i += 2) pairs.push([merged[i] as number, merged[i + 1] as number]);
  pairs.sort((x, y) => x[0] - y[0]);
  spans.length = 0;
  for (const [a, b] of pairs) spans.push(a, b);
}

function clipColor(project: Project, clip: Clip): string | null {
  if (clip.color) return clip.color;
  if (clip.kind === 'pattern') return project.patterns[clip.patternId]?.color ?? null;
  return project.channels[clip.channelId]?.color ?? null;
}

const coverage = (row: ThumbnailRow): number => {
  let columns = 0;
  for (let i = 0; i < row.spans.length; i += 2) columns += (row.spans[i + 1] as number) - (row.spans[i] as number);
  return columns;
};

/** Cuts the playlist into columns and rows. An empty playlist gives no rows. */
export function arrangementThumbnail(project: Project, columns = THUMBNAIL_COLUMNS): Thumbnail {
  const total = songLength(project);
  if (total <= 0) return { v: 1, columns, rows: [] };
  const rows = new Map<string, ThumbnailRow>();
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.length <= 0) continue;
    const start = Math.min(columns - 1, Math.max(0, Math.floor((clip.start / total) * columns)));
    const end = Math.min(columns, Math.max(start + 1, Math.ceil(((clip.start + clip.length) / total) * columns)));
    let row = rows.get(clip.laneId);
    if (!row) {
      row = { color: project.playlist.lanes[clip.laneId]?.color ?? null, spans: [] };
      rows.set(clip.laneId, row);
    }
    row.color ??= clipColor(project, clip);
    addSpan(row.spans, start, end);
  }
  // Tracks in playlist order; a project with more tracks than fit keeps the busiest ones.
  const ordered = project.playlist.laneOrder.flatMap((id) => {
    const row = rows.get(id);
    return row ? [row] : [];
  });
  if (ordered.length <= THUMBNAIL_MAX_ROWS) return { v: 1, columns, rows: ordered };
  const busiest = new Set([...ordered].sort((a, b) => coverage(b) - coverage(a)).slice(0, THUMBNAIL_MAX_ROWS));
  return { v: 1, columns, rows: ordered.filter((row) => busiest.has(row)) };
}

/** One mark of the picture, in pixels. */
export interface ThumbnailRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string | null;
}

/** The marks to draw for a picture of `width` × `height` pixels: whole pixels, the same for the same input. */
export function thumbnailRects(thumbnail: Thumbnail, width: number, height: number): ThumbnailRect[] {
  const { rows, columns } = thumbnail;
  if (rows.length === 0 || width <= 0 || height <= 0) return [];
  const rowHeight = height / rows.length;
  const gap = rowHeight >= 4 ? 1 : 0;
  const rects: ThumbnailRect[] = [];
  rows.forEach((row, index) => {
    const y = Math.round(index * rowHeight);
    const bottom = Math.round((index + 1) * rowHeight) - gap;
    for (let i = 0; i < row.spans.length; i += 2) {
      const x = Math.round(((row.spans[i] as number) / columns) * width);
      const right = Math.round(((row.spans[i + 1] as number) / columns) * width);
      rects.push({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y), color: row.color });
    }
  });
  return rects;
}

/** True when the value has the shape of a stored thumbnail (a damaged cache entry is dropped, not drawn). */
export function isThumbnail(value: unknown): value is Thumbnail {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<Thumbnail>;
  return (
    t.v === 1 &&
    typeof t.columns === 'number' &&
    t.columns > 0 &&
    Array.isArray(t.rows) &&
    t.rows.every(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        Array.isArray(row.spans) &&
        row.spans.length % 2 === 0 &&
        row.spans.every((n) => typeof n === 'number') &&
        (row.color === null || typeof row.color === 'string'),
    )
  );
}
