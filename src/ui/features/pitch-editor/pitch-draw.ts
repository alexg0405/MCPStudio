/**
 * Drawing for the Pitch editor: the grid, the notes and pitch lines, the overlay (hover card, selection box, split line,
 * playhead), the piano keys and the ruler. Each function paints one canvas layer from a `PitchScene` (what the
 * controller holds right now); none of them changes anything. The viewport's "ticks" are milliseconds on the clip's
 * sample timeline and its rows are MIDI notes.
 */
import { keyMask } from '@app/actions/pitch';
import type { ClipPitch } from '@app/pitch/state';
import { noteName } from '@agstudio/sdk/notes';
import { alpha, inkOn, mix, roundRectPath, type TimelineTheme } from '../../timeline/canvas';
import { clamp, type Viewport } from '../../timeline/viewport';
import { clockText, keyForRow, pitchText, rowForKey, type DrawNote } from './model';
import { KEYS_WIDTH, RULER_HEIGHT, type Drag, type PitchTool } from './pitch-types';

/** Everything the layers draw from. */
export interface PitchScene {
  vp: Viewport;
  clip: ClipPitch | null;
  /** The notes as drawn (with a drag's preview applied). */
  notes: readonly DrawNote[];
  /** The pitch as sung and as corrected, one MIDI note per analysis frame (NaN where unvoiced). */
  sung: Float32Array | null;
  corrected: Float32Array | null;
  selected: ReadonlySet<number>;
  /** The key the rows are shaded for, and whether to shade at all. */
  keyRoot: number;
  keyScale: string;
  showScale: boolean;
  tool: PitchTool;
  drag: Drag | null;
  /** The note under the pointer (-1 for none) and the pointer's place in the stage. */
  hover: number;
  pointer: { x: number; y: number } | null;
  /** The playhead as milliseconds on the sample timeline, NaN when nothing of this clip plays. */
  playheadMs: number;
}

/** The pitch classes (0 = C) of the black piano keys. */
const BLACK_KEY_PITCH_CLASSES = [1, 3, 6, 8, 10];
/** A note blob is this fraction of a row high, but never under this many px. */
const NOTE_HEIGHT_FRACTION = 0.78;
const MIN_NOTE_HEIGHT_PX = 5;
const NOTE_CORNER_RADIUS_PX = 4;
/** A blob must be wider than this (px) to carry its note name. */
const MIN_WIDTH_FOR_LABEL_PX = 34;
/** The width of the pitch lines, in px. */
const SUNG_LINE_PX = 1.2;
const CORRECTED_LINE_PX = 1.6;
/** Beyond this change (semitones) a note counts as moved: its original place is drawn as a dashed outline. */
const MOVED_EPSILON = 0.02;

/** The y of the middle of the row for a MIDI note (fractions are cents). */
function rowY(vp: Viewport, midi: number): number {
  return vp.rowToY(rowForKey(midi) + 0.5);
}

/** The spacing of the vertical time lines in ms: tenths of a second when zoomed in, then halves, then whole seconds. */
function timeLineStepMs(pxPerMs: number): number {
  if (pxPerMs * 1000 >= 400) return 100;
  if (pxPerMs * 1000 >= 60) return 500;
  return 1000;
}

/** What a row's background is in the grid: shaded outside the key, the tonic tinted, or the plain key colour. */
function keyRowFill(pitchClass: number, mask: readonly boolean[], keyRoot: number, theme: TimelineTheme): string {
  if (!mask[pitchClass]) return theme.shade;
  return pitchClass === keyRoot ? alpha(theme.accent, 0.1) : theme.sheen;
}

/** The background: rows shaded for the key (or black keys), time lines, and the parts outside the analysed stretch. */
export function drawGrid(ctx: CanvasRenderingContext2D, theme: TimelineTheme, scene: PitchScene): void {
  const { vp, clip } = scene;
  const { width, height } = vp;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const mask = scene.showScale ? keyMask(scene.keyRoot, scene.keyScale) : null;
  const [firstRow, lastRow] = vp.visibleRows();
  for (let row = firstRow; row <= lastRow; row++) {
    const pitchClass = keyForRow(row) % 12;
    const y = vp.rowToY(row);
    if (mask) {
      ctx.fillStyle = keyRowFill(pitchClass, mask, scene.keyRoot, theme);
      ctx.fillRect(0, y, width, vp.rowHeight);
    } else if (BLACK_KEY_PITCH_CLASSES.includes(pitchClass)) {
      ctx.fillStyle = theme.bgAlt;
      ctx.fillRect(0, y, width, vp.rowHeight);
    }
    ctx.fillStyle = pitchClass === 0 ? theme.beat : theme.lineFaint;
    ctx.fillRect(0, y + vp.rowHeight - 1, width, 1);
  }
  // Time lines: a second, with tenths when zoomed in.
  const [fromMs, toMs] = vp.visibleTicks();
  const stepMs = timeLineStepMs(vp.pxPerTick);
  ctx.fillStyle = theme.lineFaint;
  for (let t = Math.floor(fromMs / stepMs) * stepMs; t <= toMs; t += stepMs) ctx.fillRect(Math.round(vp.tickToX(t)), 0, 1, height);
  ctx.fillStyle = theme.beat;
  for (let t = Math.floor(fromMs / 1000) * 1000; t <= toMs; t += 1000) ctx.fillRect(Math.round(vp.tickToX(t)), 0, 1, height);
  // Outside the analysed stretch.
  if (clip) {
    const left = vp.tickToX(clip.range.from * 1000);
    const right = vp.tickToX(clip.range.to * 1000);
    ctx.fillStyle = theme.shade;
    if (left > 0) ctx.fillRect(0, 0, Math.min(left, width), height);
    if (right < width) ctx.fillRect(Math.max(0, right), 0, width - Math.max(0, right), height);
  }
}

/** Strokes a pitch curve (one MIDI note per analysis frame) as a line, only over the frames in view. */
function drawPitchLine(ctx: CanvasRenderingContext2D, scene: PitchScene, curve: Float32Array, lineWidth: number): void {
  const { vp, clip } = scene;
  if (!clip) return;
  const { t0, hop } = clip.analysis;
  const [fromMs, toMs] = vp.visibleTicks();
  const firstFrame = Math.max(0, Math.floor((fromMs / 1000 - t0) / hop) - 1);
  const lastFrame = Math.min(curve.length - 1, Math.ceil((toMs / 1000 - t0) / hop) + 1);
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let isPenDown = false;
  for (let i = firstFrame; i <= lastFrame; i++) {
    const midi = curve[i] as number;
    if (Number.isNaN(midi)) {
      isPenDown = false;
      continue;
    }
    const x = vp.tickToX((t0 + i * hop) * 1000);
    const y = rowY(vp, midi);
    if (isPenDown) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
      isPenDown = true;
    }
  }
  ctx.stroke();
}

/** A note that was moved: where it was sung as a dashed outline, joined to where it is now by a line. */
function drawMovedFrom(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, note: DrawNote, x0: number, x1: number, noteHeight: number): void {
  const sungY = rowY(vp, note.sung);
  const targetY = rowY(vp, note.target);
  ctx.strokeStyle = alpha(theme.textDim, 0.6);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  roundRectPath(ctx, x0, sungY - noteHeight / 2, x1 - x0, noteHeight, NOTE_CORNER_RADIUS_PX);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = alpha(theme.accent, 0.45);
  ctx.beginPath();
  ctx.moveTo((x0 + x1) / 2, sungY);
  ctx.lineTo((x0 + x1) / 2, targetY);
  ctx.stroke();
}

/** One note blob, with its name when it is wide enough. */
function drawNoteBlob(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, note: DrawNote, isSelected: boolean, noteHeight: number): void {
  const x0 = vp.tickToX(note.fromMs);
  const x1 = Math.max(x0 + 3, vp.tickToX(note.toMs));
  const centerY = rowY(vp, note.target);
  if (Math.abs(note.target - note.sung) > MOVED_EPSILON) drawMovedFrom(ctx, vp, theme, note, x0, x1, noteHeight);
  const fill = note.edited ? theme.accent : mix(theme.note, theme.bg, 0.25);
  ctx.beginPath();
  roundRectPath(ctx, x0, centerY - noteHeight / 2, x1 - x0, noteHeight, NOTE_CORNER_RADIUS_PX);
  ctx.fillStyle = alpha(fill, isSelected ? 0.95 : 0.78);
  ctx.fill();
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.strokeStyle = isSelected ? theme.noteSelected : alpha(theme.noteBorder, 0.9);
  ctx.stroke();
  if (x1 - x0 > MIN_WIDTH_FOR_LABEL_PX && noteHeight >= 10) {
    ctx.fillStyle = inkOn(fill, theme);
    ctx.font = `600 ${Math.min(11, Math.floor(noteHeight - 2))}px ${theme.font}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(pitchText(note.target, noteName), x0 + 5, centerY + 0.5);
  }
}

/** The pitch as sung (a thin line), then the note blobs, then the corrected line over them. */
export function drawContent(ctx: CanvasRenderingContext2D, theme: TimelineTheme, scene: PitchScene): void {
  const { vp } = scene;
  ctx.clearRect(0, 0, vp.width, vp.height);
  if (!scene.clip) return;
  if (scene.sung) {
    ctx.strokeStyle = alpha(theme.textDim, scene.corrected ? 0.55 : 0.8);
    drawPitchLine(ctx, scene, scene.sung, SUNG_LINE_PX);
  }
  const [fromMs, toMs] = vp.visibleTicks();
  const noteHeight = Math.max(MIN_NOTE_HEIGHT_PX, vp.rowHeight * NOTE_HEIGHT_FRACTION);
  for (const note of scene.notes) {
    if (note.toMs < fromMs || note.fromMs > toMs) continue;
    drawNoteBlob(ctx, vp, theme, note, scene.selected.has(note.index), noteHeight);
  }
  if (scene.corrected) {
    ctx.strokeStyle = theme.accentLight;
    drawPitchLine(ctx, scene, scene.corrected, CORRECTED_LINE_PX);
  }
}

/** The lines of the card that follows a hovered (or dragged) note: its pitch, its time span, and any drift or vibrato edits. */
function noteCardLines(note: DrawNote): string[] {
  const movedNote = Math.abs(note.target - note.sung) > MOVED_EPSILON ? `  (sung ${pitchText(note.sung, noteName)})` : '';
  const lines = [`${pitchText(note.target, noteName)}${movedNote}`, `${clockText(note.fromMs / 1000)}–${clockText(note.toMs / 1000)}`];
  if (note.drift > 0.0005) lines.push(`drift flattened ${Math.round(note.drift * 100)} %`);
  if (Math.abs(note.vibrato - 1) > 0.0005) lines.push(`vibrato ${Math.round(note.vibrato * 100)} %`);
  return lines;
}

/** The card above a note with its details. */
function drawNoteCard(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, note: DrawNote): void {
  const lines = noteCardLines(note);
  ctx.font = `500 11px ${theme.font}`;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
  const height = lines.length * 14 + 8;
  const x = clamp(vp.tickToX((note.fromMs + note.toMs) / 2) - width / 2, 4, Math.max(4, vp.width - width - 4));
  const y = clamp(rowY(vp, note.target) - vp.rowHeight - height, 4, Math.max(4, vp.height - height - 4));
  ctx.beginPath();
  roundRectPath(ctx, x, y, width, height, 5);
  ctx.fillStyle = theme.glass;
  ctx.fill();
  ctx.fillStyle = theme.text;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, x + 7, y + 5 + i * 14));
}

/** What is drawn over the notes: the hover card, the selection box, the split line and the playhead. */
export function drawOverlay(ctx: CanvasRenderingContext2D, theme: TimelineTheme, scene: PitchScene): void {
  const { vp, drag } = scene;
  ctx.clearRect(0, 0, vp.width, vp.height);
  if (!scene.clip) return;
  const infoIndex = drag?.kind === 'move' ? drag.anchor : scene.hover;
  const infoNote = scene.notes[infoIndex];
  if (infoNote) drawNoteCard(ctx, vp, theme, infoNote);
  if (drag?.kind === 'marquee') {
    ctx.fillStyle = theme.selectTint;
    ctx.strokeStyle = theme.select;
    ctx.lineWidth = 1;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
  }
  if (scene.tool === 'split' && scene.pointer && scene.hover >= 0 && !drag) {
    ctx.fillStyle = theme.accent;
    ctx.fillRect(Math.round(scene.pointer.x), 0, 1, vp.height);
  }
  if (!Number.isNaN(scene.playheadMs)) {
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(Math.round(vp.tickToX(scene.playheadMs)), 0, 1, vp.height);
  }
}

/** The piano keys down the left edge, with the key's rows marked and the note names of C and the key's white keys. */
export function drawKeys(ctx: CanvasRenderingContext2D, theme: TimelineTheme, scene: PitchScene): void {
  const { vp } = scene;
  ctx.clearRect(0, 0, KEYS_WIDTH, vp.height);
  const mask = keyMask(scene.keyRoot, scene.keyScale);
  const [firstRow, lastRow] = vp.visibleRows();
  ctx.font = `500 10px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let row = firstRow; row <= lastRow; row++) {
    const key = keyForRow(row);
    const pitchClass = key % 12;
    const isBlack = BLACK_KEY_PITCH_CLASSES.includes(pitchClass);
    const y = vp.rowToY(row);
    ctx.fillStyle = isBlack ? theme.keyBlack : theme.keyWhite;
    ctx.fillRect(0, y, isBlack ? KEYS_WIDTH * 0.62 : KEYS_WIDTH, vp.rowHeight - 1);
    if (!isBlack) {
      ctx.fillStyle = mask[pitchClass] ? alpha(theme.accent, pitchClass === scene.keyRoot ? 0.35 : 0.1) : 'transparent';
      ctx.fillRect(0, y, KEYS_WIDTH, vp.rowHeight - 1);
    }
    if (pitchClass === 0 || (vp.rowHeight >= 14 && !isBlack && mask[pitchClass])) {
      ctx.fillStyle = isBlack ? theme.keyWhite : theme.onLight;
      ctx.fillText(noteName(key), KEYS_WIDTH - 24, y + vp.rowHeight / 2);
    }
  }
}

/** The seconds between ruler labels at a zoom: every second when zoomed in, up to every 30 s when zoomed out. */
function rulerEverySeconds(pxPerSecond: number): number {
  if (pxPerSecond >= 90) return 1;
  if (pxPerSecond >= 40) return 2;
  if (pxPerSecond >= 18) return 5;
  if (pxPerSecond >= 8) return 10;
  return 30;
}

/** The time ruler along the top: a tick and a clock time every few seconds. */
export function drawRuler(ctx: CanvasRenderingContext2D, theme: TimelineTheme, scene: PitchScene): void {
  const { vp } = scene;
  ctx.fillStyle = theme.surface2;
  ctx.fillRect(0, 0, vp.width, RULER_HEIGHT);
  const [fromMs, toMs] = vp.visibleTicks();
  const every = rulerEverySeconds(vp.pxPerTick * 1000);
  ctx.fillStyle = theme.textDim;
  ctx.font = `500 10px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let seconds = Math.floor(fromMs / 1000 / every) * every; seconds * 1000 <= toMs; seconds += every) {
    const x = Math.round(vp.tickToX(seconds * 1000));
    ctx.fillRect(x, RULER_HEIGHT - 5, 1, 5);
    ctx.fillText(clockText(seconds), x + 3, RULER_HEIGHT / 2 - 1);
  }
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, RULER_HEIGHT - 1, vp.width, 1);
}
