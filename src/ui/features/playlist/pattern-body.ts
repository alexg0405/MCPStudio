/**
 * The mini piano roll inside a pattern clip. A pattern's notes are turned into drawing paths once per zoom level (and
 * into a small picture when the pattern is short), so a pattern used by dozens of clips costs a few fills or one
 * `drawImage` per repeat instead of thousands of note shapes.
 */
import type { Note, Pattern, PatternClip, TimeSignature, Tick } from '@core/model/types';
import { notesSorted, patternLength } from '@core/query/queries';
import type { Viewport } from '../../timeline/viewport';
import type { ClipPaint } from './clip-paint';

/** A pattern's notes as the clip body needs them, kept per pattern object (patterns are replaced when they change). */
interface PatternPreview {
  notes: readonly Note[];
  /** Lowest and highest key of any note. */
  lowestKey: number;
  highestKey: number;
  length: Tick;
  /** A note runs past the pattern's end into the next repeat, so repeats overlap. */
  spills: boolean;
  /** The notes as paths per zoom (see `notePaths`). */
  paths: Map<string, NotePaths>;
  /** The notes pre-drawn into a small canvas per zoom and color (see `patternBitmap`). */
  bitmaps: Map<string, HTMLCanvasElement>;
}

/** The notes of a pattern as one path per velocity step. */
interface NotePaths {
  paths: Path2D[];
  /** Whether the path of each step has any note (empty ones are not filled). */
  hasNotes: boolean[];
}

/** The velocity steps the mini notes are drawn in: one path per step (few fills), the velocity shows as opacity. */
const VELOCITY_STEPS = [0.45, 0.65, 0.82, 1] as const;

/** The step a note's velocity falls into: up to 0.45, up to 0.65, up to 0.82, and everything louder. */
function velocityStepOf(velocity: number): number {
  if (velocity <= 0.45) return 0;
  if (velocity <= 0.65) return 1;
  if (velocity <= 0.82) return 2;
  return 3;
}

/** The note opacity of a velocity step: never fully faint, loudest steps solid. */
function stepOpacity(step: number): number {
  return 0.4 + 0.6 * (VELOCITY_STEPS[step] as number);
}

/** How many zoom levels of paths are kept per pattern (the oldest goes first). */
const MAX_PATH_ZOOMS = 6;
/** How many zoom and color combinations of pictures are kept per pattern. */
const MAX_BITMAPS = 2;
/** Widest pattern picture (device pixels) worth keeping; longer patterns draw their paths. */
const MAX_BITMAP_WIDTH = 3000;
const MAX_BITMAP_HEIGHT = 1200;

/** Mini notes are at least this many key rows tall (px) and at most `MAX_NOTE_ROW_PX`. */
const MIN_NOTE_ROW_PX = 1;
const MAX_NOTE_ROW_PX = 4;
/** The mini piano roll shows at least this many keys, so a one-note pattern does not fill the clip. */
const MIN_KEY_SPAN = 8;
/** Notes are at least this wide (px); a note drawn narrower would vanish. */
const MIN_NOTE_WIDTH_PX = 1.5;
/** Notes at least this tall (px) get rounded corners, and at least this wide too. */
const ROUND_NOTE_MIN_ROW_PX = 2;
const ROUND_NOTE_MIN_WIDTH_PX = 3;
/** Below this zoom (px per tick) notes in the same pixel column coincide, so only the widest of them is kept. */
const COINCIDE_BELOW_PX_PER_TICK = 0.02;

const previewCache = new WeakMap<Pattern, PatternPreview>();

function patternPreview(pattern: Pattern, timeSig: TimeSignature): PatternPreview {
  const cached = previewCache.get(pattern);
  if (cached) return cached;
  const notes: Note[] = [];
  for (const byId of Object.values(pattern.notes)) if (byId) notes.push(...notesSorted(byId));
  notes.sort((a, b) => a.tick - b.tick);
  let lowestKey = 127;
  let highestKey = 0;
  for (const note of notes) {
    lowestKey = Math.min(lowestKey, note.key);
    highestKey = Math.max(highestKey, note.key);
  }
  const length = patternLength(pattern, timeSig);
  const preview: PatternPreview = {
    notes,
    lowestKey,
    highestKey,
    length,
    spills: notes.some((note) => note.tick + note.length > length),
    paths: new Map(),
    bitmaps: new Map(),
  };
  previewCache.set(pattern, preview);
  return preview;
}

/**
 * A pattern's notes as one path per velocity step, in the pattern's own coordinates (x from its start, y from the top of
 * the clip body). Drawn once per clip repeat by translating, so a pattern used by dozens of clips is built once per zoom
 * instead of once per clip. A note hidden inside an earlier one of the same step (same key and pixel column, no longer)
 * adds nothing to the fill and is left out.
 */
function notePaths(preview: PatternPreview, pxPerTick: number, bodyHeight: number): NotePaths {
  const zoomKey = `${pxPerTick}|${bodyHeight}`;
  const cached = preview.paths.get(zoomKey);
  if (cached) return cached;
  const keySpan = Math.max(MIN_KEY_SPAN, preview.highestKey - preview.lowestKey + 1);
  const rowPx = noteRowHeight(bodyHeight, keySpan);
  const hasRoundedNotes = rowPx >= ROUND_NOTE_MIN_ROW_PX;
  const paths = VELOCITY_STEPS.map(() => new Path2D());
  const hasNotes = VELOCITY_STEPS.map(() => false);
  const widestSeen = VELOCITY_STEPS.map(() => new Map<number, number>());
  const padKeys = (keySpan - (preview.highestKey - preview.lowestKey + 1)) / 2;
  for (const note of preview.notes) {
    const step = velocityStepOf(note.velocity);
    const x = note.tick * pxPerTick;
    const width = Math.max(MIN_NOTE_WIDTH_PX, note.length * pxPerTick - 1);
    // Zoomed out, notes within a pixel column coincide; zoomed in, only exact repeats may be dropped.
    const cell = (pxPerTick < COINCIDE_BELOW_PX_PER_TICK ? Math.round(x) : x) * 128 + note.key;
    const seen = widestSeen[step] as Map<number, number>;
    if ((seen.get(cell) ?? 0) >= width) continue;
    seen.set(cell, width);
    const y = bodyHeight - ((note.key - preview.lowestKey + 1 + padKeys) / keySpan) * bodyHeight;
    const path = paths[step] as Path2D;
    if (hasRoundedNotes && width >= ROUND_NOTE_MIN_WIDTH_PX) path.roundRect(x, y, width, rowPx, Math.min(rowPx / 2, width / 2));
    else path.rect(x, y, width, rowPx);
    hasNotes[step] = true;
  }
  if (preview.paths.size >= MAX_PATH_ZOOMS) preview.paths.delete(preview.paths.keys().next().value as string);
  const built = { paths, hasNotes };
  preview.paths.set(zoomKey, built);
  return built;
}

/** Height of one key row of mini notes: what fits the body, between `MIN_NOTE_ROW_PX` and `MAX_NOTE_ROW_PX`. */
function noteRowHeight(bodyHeight: number, keySpan: number): number {
  const fit = bodyHeight / keySpan;
  // A little gap between rows once they are tall enough to spare it.
  const gap = fit > 2.5 ? 0.6 : 0;
  return Math.max(MIN_NOTE_ROW_PX, Math.min(MAX_NOTE_ROW_PX, fit - gap));
}

/**
 * One repeat of a pattern's notes drawn once into a canvas, so a pattern used by dozens of clips costs a blit per clip
 * instead of filling thousands of note shapes each time. Kept for the last two zoom and color combinations (the canvas
 * is the pattern's length wide, so this is for the zoomed-out, busy views).
 */
function patternBitmap(
  preview: PatternPreview,
  built: NotePaths,
  pxPerTick: number,
  bodyHeight: number,
  devicePixelRatio: number,
  color: string,
): HTMLCanvasElement {
  const key = `${pxPerTick}|${bodyHeight}|${devicePixelRatio}|${color}`;
  const cached = preview.bitmaps.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(preview.length * pxPerTick * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(bodyHeight * devicePixelRatio));
  const bitmapCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
  bitmapCtx.scale(devicePixelRatio, devicePixelRatio);
  bitmapCtx.fillStyle = color;
  for (let step = 0; step < VELOCITY_STEPS.length; step++) {
    if (!built.hasNotes[step]) continue;
    bitmapCtx.globalAlpha = stepOpacity(step);
    bitmapCtx.fill(built.paths[step] as Path2D);
  }
  if (preview.bitmaps.size >= MAX_BITMAPS) preview.bitmaps.delete(preview.bitmaps.keys().next().value as string);
  preview.bitmaps.set(key, canvas);
  return canvas;
}

/**
 * Draws a pattern clip's notes into its body (`x`, `y`, `w`, `h` in canvas pixels). The clip shows the pattern from
 * `clip.offset`, repeating every pattern length; only the repeats on screen are drawn.
 */
export function drawPatternBody(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  pattern: Pattern,
  timeSig: TimeSignature,
  clip: PatternClip,
  x: number,
  w: number,
  y: number,
  h: number,
  paint: ClipPaint,
): void {
  const preview = patternPreview(pattern, timeSig);
  if (preview.notes.length === 0 || preview.length <= 0) return;
  const pxPerTick = vp.pxPerTick;
  const visibleLeft = Math.max(x, 0);
  const visibleRight = Math.min(x + w, vp.width);
  if (visibleRight <= visibleLeft) return;
  const built = notePaths(preview, pxPerTick, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y, w - 2, h);
  ctx.clip();
  ctx.fillStyle = paint.content;
  const baseAlpha = ctx.globalAlpha;
  const from = Math.max(clip.start, vp.xToTick(visibleLeft));
  const to = Math.min(clip.start + clip.length, vp.xToTick(visibleRight));
  // (One repeat earlier too: a note longer than the pattern spills into the next repeat.)
  const firstRepeat = Math.max(
    Math.floor(clip.offset / preview.length),
    Math.floor((from - clip.start + clip.offset) / preview.length) - 1,
  );
  const devicePixelRatio = ctx.getTransform().a || 1;
  const fitsInPicture =
    !preview.spills && preview.length * pxPerTick * devicePixelRatio <= MAX_BITMAP_WIDTH && h * devicePixelRatio <= MAX_BITMAP_HEIGHT;
  if (fitsInPicture) {
    const bitmap = patternBitmap(preview, built, pxPerTick, h, devicePixelRatio, paint.content);
    blitRepeats(ctx, vp, preview, clip, bitmap, devicePixelRatio, firstRepeat, to, y);
  } else {
    fillRepeats(ctx, vp, preview, clip, built, baseAlpha, firstRepeat, to, y);
  }
  ctx.restore();
}

/** A pattern that fits in a small picture is drawn as that picture, once per repeat. */
function blitRepeats(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  preview: PatternPreview,
  clip: PatternClip,
  bitmap: HTMLCanvasElement,
  devicePixelRatio: number,
  firstRepeat: number,
  endTick: Tick,
  y: number,
): void {
  for (let repeat = firstRepeat; ; repeat++) {
    const repeatStart = clip.start - clip.offset + repeat * preview.length;
    if (repeatStart >= endTick) break;
    // On whole device pixels, so every repeat is as sharp as the others.
    ctx.drawImage(bitmap, vp.tickToPx(repeatStart), y, bitmap.width / devicePixelRatio, bitmap.height / devicePixelRatio);
  }
}

/**
 * Repeats that do not overlap are filled one by one; with notes spilling into the next repeat, the repeats are joined
 * first so overlapping notes are filled once (as one path of every note would be).
 */
function fillRepeats(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  preview: PatternPreview,
  clip: PatternClip,
  built: NotePaths,
  baseAlpha: number,
  firstRepeat: number,
  endTick: Tick,
  y: number,
): void {
  const joined = preview.spills ? VELOCITY_STEPS.map(() => new Path2D()) : null;
  for (let repeat = firstRepeat; ; repeat++) {
    const repeatStart = clip.start - clip.offset + repeat * preview.length;
    if (repeatStart >= endTick) break;
    const repeatX = vp.tickToPx(repeatStart);
    if (joined) {
      for (let step = 0; step < VELOCITY_STEPS.length; step++) {
        if (built.hasNotes[step]) (joined[step] as Path2D).addPath(built.paths[step] as Path2D, new DOMMatrix().translate(repeatX, y));
      }
      continue;
    }
    ctx.translate(repeatX, y);
    for (let step = 0; step < VELOCITY_STEPS.length; step++) {
      if (!built.hasNotes[step]) continue;
      ctx.globalAlpha = baseAlpha * stepOpacity(step);
      ctx.fill(built.paths[step] as Path2D);
    }
    ctx.translate(-repeatX, -y);
  }
  if (joined) {
    for (let step = 0; step < VELOCITY_STEPS.length; step++) {
      ctx.globalAlpha = baseAlpha * stepOpacity(step);
      ctx.fill(joined[step] as Path2D);
    }
  }
  ctx.globalAlpha = baseAlpha;
}
