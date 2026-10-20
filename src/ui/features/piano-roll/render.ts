/**
 * Piano roll drawing. Pure functions of (context, viewport, data): the controller decides when each
 * layer needs redrawing. All coordinates are CSS pixels.
 */
import type { NoteLane } from '@app/stores/editor';
import type { Note, NoteId, Tick, TimeSignature } from '@core/model/types';
import { keyName, ticksPerBar, ticksPerBeat, TICKS_PER_STEP } from '@core/time/ppq';
import { alpha, inkOn, isBlackKey, mix, roundRectPath, type TimelineTheme, fontPx } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { laneValue, LANES } from './lanes';

/** The key shown on a row of the grid (the top row is the highest key, 127). */
export const keyForRow = (row: number) => 127 - row;
/** The row of the grid a key is shown on (the inverse of `keyForRow`). */
export const rowForKey = (key: number) => 127 - key;

/** The song key as the grid shows it: which pitch classes are in the scale, and the tonic. */
export interface ScaleRows {
  /** Index = pitch class (key % 12). */
  mask: readonly boolean[];
  root: number;
}

/** A chord of the chord track as the grid shows it: where it sounds, its notes as pitch classes, and its name. */
export interface ChordBand {
  tick: Tick;
  length: Tick;
  /** Index = pitch class (key % 12): true for the chord's notes. */
  mask: readonly boolean[];
  /** Pitch class of the root (the bass for a slash chord). */
  root: number;
  name: string;
}

/** Rows of the chord's notes tinted over the chord's stretch, the root a little stronger, and its name at the top. */
export function drawChordBands(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, bands: readonly ChordBand[]): void {
  const [r0, r1] = vp.visibleRows();
  const [t0, t1] = vp.visibleTicks();
  ctx.font = `600 ${fontPx(10)}px ${theme.font}`;
  ctx.textBaseline = 'top';
  for (const band of bands) {
    if (band.tick > t1 || band.tick + band.length < t0) continue;
    const x0 = vp.tickToPx(band.tick);
    const x1 = vp.tickToPx(band.tick + band.length);
    for (let row = r0; row <= r1; row++) {
      const pc = keyForRow(row) % 12;
      if (!band.mask[pc]) continue;
      const y = vp.snap(vp.rowToY(row));
      const bottom = vp.snap(vp.rowToY(row) + vp.rowHeight);
      ctx.fillStyle = alpha(theme.accent, pc === band.root ? 0.26 : 0.14);
      ctx.fillRect(x0, y, x1 - x0, bottom - y - 1);
    }
    // The chord's edge and name, so the notes can be placed against the harmony.
    ctx.fillStyle = alpha(theme.accent, 0.5);
    ctx.fillRect(x0, 0, 1, vp.height);
    if (x1 - x0 > 24) {
      ctx.fillStyle = theme.accentLight;
      ctx.fillText(band.name, x0 + 4, 3);
    }
  }
}

/**
 * Background rows, grid lines and the area past the pattern end. With a song key, rows in the
 * scale are light, rows outside it dark and the tonic's rows tinted (instead of black/white keys).
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  ts: TimeSignature,
  patternEnd: Tick,
  scale: ScaleRows | null = null,
  chords: readonly ChordBand[] | null = null,
): void {
  const { width, height } = vp;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const [r0, r1] = vp.visibleRows();
  for (let row = r0; row <= r1; row++) {
    const key = keyForRow(row);
    // Rows on whole device pixels: each band and hairline is drawn between two snapped edges.
    const y = vp.snap(vp.rowToY(row));
    const bottom = vp.snap(vp.rowToY(row) + vp.rowHeight);
    if (scale) {
      const pc = key % 12;
      ctx.fillStyle = !scale.mask[pc] ? theme.shade : pc === scale.root ? alpha(theme.accent, 0.1) : theme.sheen;
      ctx.fillRect(0, y, width, bottom - y);
    } else if (isBlackKey(key)) {
      ctx.fillStyle = theme.bgAlt;
      ctx.fillRect(0, y, width, bottom - y);
    }
    // Row hairlines; the octave boundary (between B and C) a little stronger.
    ctx.fillStyle = key % 12 === 0 ? theme.beat : theme.lineFaint;
    ctx.fillRect(0, bottom - 1, width, 1);
  }

  if (chords && chords.length > 0) drawChordBands(ctx, vp, theme, chords);

  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  const lines: [Tick, string][] = [];
  if (TICKS_PER_STEP * vp.pxPerTick >= 6) lines.push([TICKS_PER_STEP, theme.lineFaint]);
  if (beat * vp.pxPerTick >= 6) lines.push([beat, theme.beat]);
  lines.push([bar * vp.pxPerTick >= 4 ? bar : bar * 4, theme.bar]);
  for (const [every, color] of lines) {
    ctx.fillStyle = color;
    for (let t = Math.floor(t0 / every) * every; t <= t1; t += every) {
      ctx.fillRect(vp.tickToPx(t), 0, 1, height);
    }
  }

  // Shade everything after the pattern's end.
  const endX = vp.tickToPx(patternEnd);
  if (endX < width) {
    ctx.fillStyle = theme.shade;
    ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height);
  }
}

/** How notes are drawn: their color and which are selected. */
export interface NoteStyle {
  color: string;
  selected: ReadonlySet<NoteId>;
}

/** Velocity steps notes are drawn in: one path per step and state, velocity as opacity. */
const VEL_STEPS = [0.3, 0.5, 0.7, 0.85, 1] as const;
const velStep = (v: number) => {
  for (let i = 0; i < VEL_STEPS.length - 1; i++) if (v <= (VEL_STEPS[i] as number)) return i;
  return VEL_STEPS.length - 1;
};

/** One batch of notes: their bodies and their lighter top edges. */
interface NoteGroup {
  body: Path2D;
  top: Path2D;
  any: boolean;
}

/** A note is drawn in one of these states: its batch of paths (and its fill color) depends on it. */
const NOTE_NORMAL = 0;
const NOTE_SELECTED = 1;
const NOTE_MUTED = 2;
const NOTE_STATES = 3;
/** Muted notes are drawn this much fainter. */
const MUTED_OPACITY = 0.35;
/** Notes at least this wide (px), on rows at least this tall (px), get their key name written on them. */
const MIN_LABELED_WIDTH = 26;
const MIN_LABELED_ROW_HEIGHT = 10;

/** The visible notes batched by state and velocity step, and the ones that get a label. */
interface NoteBatches {
  /** [state][velocity step]: a group (two paths) is made when its first note arrives, as most frames use only a few. */
  groups: (NoteGroup | undefined)[][];
  labels: Note[];
  /** The height of a note (px). */
  noteHeight: number;
}

/**
 * Notes overlapping the view: rounded, gold with a lighter top edge, velocity as opacity, selected
 * ones in the selection color. Notes are batched into a few paths (by state and velocity step), so
 * 10k notes stay smooth. `skip` hides originals that are being dragged.
 */
export function drawNotes(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  notes: readonly Note[],
  style: NoteStyle,
  opts: { skip?: ReadonlySet<NoteId>; alpha?: number } = {},
): void {
  const batches = batchVisibleNotes(vp, notes, style, opts.skip);
  const baseAlpha = opts.alpha ?? 1;
  fillNoteBatches(ctx, theme, style, batches, baseAlpha);
  ctx.lineWidth = 1;
  if (batches.labels.length) drawNoteLabels(ctx, vp, theme, style, batches.labels, baseAlpha);
  ctx.globalAlpha = 1;
}

/** Sorts the notes in view into paths by state and velocity step (rounded when there is room). */
function batchVisibleNotes(vp: Viewport, notes: readonly Note[], style: NoteStyle, skip?: ReadonlySet<NoteId>): NoteBatches {
  const [firstTick, lastTick] = vp.visibleTicks();
  const [firstRow, lastRow] = vp.visibleRows();
  const rowHeight = vp.rowHeight;
  const noteHeight = Math.max(1, rowHeight - 2);
  const radius = cornerRadius(noteHeight);
  const groups: (NoteGroup | undefined)[][] = [[], [], []];
  const labels: Note[] = [];
  // Indexed, not for-of: an iterator object per note was garbage on every frame the view moves.
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i] as Note;
    if (note.tick > lastTick) break;
    if (note.tick + note.length < firstTick || skip?.has(note.id)) continue;
    const row = rowForKey(note.key);
    if (row < firstRow - 1 || row > lastRow + 1) continue;
    const x = vp.tickToPx(note.tick);
    const width = Math.max(2, vp.tickToPx(note.tick + note.length) - x - 1);
    const y = vp.rowToY(row) + 1;
    const state = noteStateOf(note, style);
    const byStep = groups[state] as (NoteGroup | undefined)[];
    const step = velStep(note.velocity);
    let group = byStep[step];
    if (!group) byStep[step] = group = { body: new Path2D(), top: new Path2D(), any: false };
    if (radius > 0 && width >= 4) group.body.roundRect(x, y, width, noteHeight, Math.min(radius, width / 2));
    else group.body.rect(x, y, width, noteHeight);
    if (noteHeight >= 4 && width > 3) group.top.rect(x + 1.5, y + 0.5, width - 3, 1);
    group.any = true;
    if (width > MIN_LABELED_WIDTH && rowHeight >= MIN_LABELED_ROW_HEIGHT) labels.push(note);
  }
  return { groups, labels, noteHeight };
}

/** Corner radius of a note (px): none on notes too short to show one. */
function cornerRadius(noteHeight: number): number {
  if (noteHeight >= 6) return 3;
  return noteHeight >= 4 ? 1.5 : 0;
}

function noteStateOf(note: Note, style: NoteStyle): number {
  if (note.muted) return NOTE_MUTED;
  return style.selected.has(note.id) ? NOTE_SELECTED : NOTE_NORMAL;
}

/** Fills each batch: the body in the state's color with the velocity as opacity, an outline, the lighter top edge. */
function fillNoteBatches(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  style: NoteStyle,
  batches: NoteBatches,
  baseAlpha: number,
): void {
  const colors = [style.color, theme.noteSelected, style.color];
  const edge = alpha(theme.noteBorder, 0.6);
  for (let state = 0; state < NOTE_STATES; state++) {
    for (let step = 0; step < VEL_STEPS.length; step++) {
      const group = (batches.groups[state] as (NoteGroup | undefined)[])[step];
      if (!group?.any) continue;
      const opacity = (0.4 + 0.6 * (VEL_STEPS[step] as number)) * (state === NOTE_MUTED ? MUTED_OPACITY : 1);
      ctx.globalAlpha = baseAlpha * opacity;
      ctx.fillStyle = colors[state] as string;
      ctx.fill(group.body);
      ctx.globalAlpha = baseAlpha * Math.max(0.55, opacity);
      if (batches.noteHeight >= 6) {
        ctx.strokeStyle = state === NOTE_SELECTED ? theme.select : edge;
        ctx.lineWidth = state === NOTE_SELECTED ? 1.25 : 0.75;
        ctx.stroke(group.body);
      }
      ctx.fillStyle = theme.noteTop;
      ctx.fill(group.top);
    }
  }
}

/** The key name ("C4") written on the notes wide enough for it. */
function drawNoteLabels(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  style: NoteStyle,
  labels: readonly Note[],
  baseAlpha: number,
): void {
  ctx.globalAlpha = baseAlpha;
  ctx.font = `500 ${Math.min(fontPx(10), vp.rowHeight - 4)}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const note of labels) {
    const x = vp.tickToPx(note.tick);
    const width = Math.max(2, vp.tickToPx(note.tick + note.length) - x - 1);
    const y = vp.rowToY(rowForKey(note.key));
    const fill = style.selected.has(note.id) ? theme.noteSelected : style.color;
    ctx.fillStyle = alpha(inkOn(fill, theme), 0.72);
    ctx.fillText(keyName(note.key), x + 4, y + vp.rowHeight / 2 + 0.5, width - 6);
  }
}

/** Other channels' notes, drawn as faint outlines behind the edited channel. */
export function drawGhosts(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  notes: readonly Note[],
): void {
  const [t0, t1] = vp.visibleTicks();
  const h = vp.rowHeight;
  // Built on the context's own path, not a Path2D per call: this runs every frame while the view follows
  // the playhead, and a new Path2D each time was garbage each frame. Same shapes, same fill.
  ctx.beginPath();
  const gh = Math.max(1, h - 4);
  // Indexed, not for-of: an iterator per frame's walk over every ghost note was garbage (see above).
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.tick > t1) break;
    if (n.tick + n.length < t0) continue;
    const y = vp.rowToY(rowForKey(n.key));
    if (y < -h || y > vp.height) continue;
    const x = vp.tickToPx(n.tick);
    const w = Math.max(2, vp.tickToPx(n.tick + n.length) - x - 1);
    if (gh >= 5 && w >= 4) ctx.roundRect(x, y + 2, w, gh, 2);
    else ctx.rect(x, y + 2, w, gh);
  }
  ctx.fillStyle = theme.ghost;
  ctx.fill();
  ctx.beginPath();
}

const keyGradients = new Map<string, CanvasGradient>();

/** Black keys: polished stone, lighter toward the front edge (cached per theme and width). */
function blackKeyFill(ctx: CanvasRenderingContext2D, theme: TimelineTheme, w: number): CanvasGradient {
  const key = `${theme.keyBlack}|${theme.keyWhite}|${w}`;
  let g = keyGradients.get(key);
  if (!g) {
    if (keyGradients.size > 16) keyGradients.clear();
    g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, theme.keyBlack);
    g.addColorStop(0.8, mix(theme.keyBlack, theme.keyWhite, 0.88));
    g.addColorStop(1, mix(theme.keyBlack, theme.keyWhite, 0.72));
    keyGradients.set(key, g);
  }
  return g;
}

/** The sizes and colors shared by every key of the strip. */
interface KeyStrip {
  width: number;
  rowHeight: number;
  /** How far a black key reaches into the strip (px). */
  blackWidth: number;
  /** Dark ink for marks on the ivory keys. */
  ink: string;
  /** The seam between two white keys. */
  seam: string;
}

/**
 * Piano keyboard on the left: ivory keys with soft shadows under the black ones, black keys like
 * polished stone. `pressed` keys light in gold; with a song key, scale keys get a dot.
 */
export function drawKeys(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  width: number,
  pressed: ReadonlySet<number>,
  rootKey: number | null,
  scale: ScaleRows | null = null,
): void {
  ctx.fillStyle = theme.keyWhite;
  ctx.fillRect(0, 0, width, vp.height);
  const [firstRow, lastRow] = vp.visibleRows();
  const rowHeight = vp.rowHeight;
  const ink = theme.onLight;
  const strip: KeyStrip = { width, rowHeight, blackWidth: Math.round(width * 0.6), ink, seam: alpha(ink, 0.14) };
  ctx.font = `500 ${Math.min(fontPx(9), rowHeight - 3)}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let row = firstRow; row <= lastRow; row++) {
    const key = keyForRow(row);
    drawKeyRow(ctx, theme, strip, key, vp.rowToY(row), pressed.has(key), key === rootKey, scale);
  }
  // The keyboard's edge against the grid.
  ctx.fillStyle = alpha(ink, 0.18);
  ctx.fillRect(width - 1, 0, 1, vp.height);
}

/** One key of the strip, at height `y`: its ivory or stone, its seam and shadow, the root marker, the scale dot, the octave name. */
function drawKeyRow(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  strip: KeyStrip,
  key: number,
  y: number,
  isPressed: boolean,
  isRoot: boolean,
  scale: ScaleRows | null,
): void {
  const { width, rowHeight: h, blackWidth, ink } = strip;
  const isBlack = isBlackKey(key);
  const pitchClass = ((key % 12) + 12) % 12;
  if (!isBlack && isPressed) {
    ctx.fillStyle = alpha(theme.accent, 0.55);
    ctx.fillRect(0, y, width, h);
  }
  // The seam between two white keys (B|C and E|F sit next to each other).
  if (pitchClass === 0 || pitchClass === 5) {
    ctx.fillStyle = strip.seam;
    ctx.fillRect(0, y + h - 1, width, 1);
  }
  if (isBlack) {
    // A soft shadow the key casts on the ivory below it.
    ctx.fillStyle = alpha(ink, 0.12);
    ctx.fillRect(0, y + h - 0.5, blackWidth + 2, 2.5);
    ctx.fillStyle = isPressed ? theme.accent : blackKeyFill(ctx, theme, blackWidth);
    ctx.beginPath();
    roundRectPath(ctx, -3, y + 0.5, blackWidth + 3, h - 1, 2);
    ctx.fill();
    if (!isPressed && h >= 6) {
      ctx.fillStyle = alpha(theme.keyWhite, 0.12);
      ctx.fillRect(2, y + 1.5, blackWidth - 6, 1);
    }
  }
  if (isRoot) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    roundRectPath(ctx, width - 4.5, y + 1, 2.5, h - 2, 1.25);
    ctx.fill();
  }
  if (scale?.mask[pitchClass] && h >= 6) drawScaleDot(ctx, theme, strip, y, pitchClass === scale.root, isBlack);
  if (pitchClass === 0 && h >= 8) {
    ctx.fillStyle = alpha(ink, 0.5);
    ctx.fillText(keyName(key), blackWidth + 3, y + h / 2 + 0.5);
  }
}

/** A dot at the left end of the scale's keys (gold for the root), clear of the octave labels. */
function drawScaleDot(ctx: CanvasRenderingContext2D, theme: TimelineTheme, strip: KeyStrip, y: number, isRoot: boolean, isBlack: boolean): void {
  const radius = Math.min(2.25, (strip.rowHeight - 3) / 2);
  ctx.beginPath();
  ctx.arc(7, y + strip.rowHeight / 2, radius, 0, Math.PI * 2);
  if (isRoot) ctx.fillStyle = theme.accent;
  else ctx.fillStyle = isBlack ? alpha(theme.keyWhite, 0.6) : alpha(strip.ink, 0.35);
  ctx.fill();
}

/** Every how many bars a number is written: all of them when there is room, fewer as the view zooms out. */
function barLabelInterval(barWidthPx: number): number {
  if (barWidthPx >= 40) return 1;
  if (barWidthPx >= 20) return 2;
  return barWidthPx >= 8 ? 4 : 16;
}

/** Bar numbers and beat ticks above the grid: hairlines, faint numbers, the pattern end as a gold flag. */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  ts: TimeSignature,
  height: number,
  patternEnd: Tick,
): void {
  ctx.fillStyle = theme.surface2;
  ctx.fillRect(0, 0, vp.width, height);
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  const barPx = bar * vp.pxPerTick;
  const labelEvery = barLabelInterval(barPx);
  ctx.font = `500 ${fontPx(10)}px ${theme.font}`;
  ctx.textBaseline = 'top';
  if (beat * vp.pxPerTick >= 8) {
    ctx.fillStyle = theme.lineFaint;
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat) {
      if (t % bar === 0) continue;
      ctx.fillRect(vp.tickToPx(t), height - 4, 1, 4);
    }
  }
  const tick = alpha(theme.textFaint, 0.6);
  for (let b = Math.floor(t0 / bar); b * bar <= t1; b++) {
    const x = vp.tickToPx(b * bar);
    ctx.fillStyle = tick;
    ctx.fillRect(x, height - 7, 1, 7);
    if (b % labelEvery === 0) {
      ctx.fillStyle = theme.textFaint;
      ctx.fillText(String(b + 1), x + 3, 4);
    }
  }
  const endX = vp.tickToPx(patternEnd);
  if (endX >= 0 && endX <= vp.width) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.moveTo(endX, height - 1);
    ctx.lineTo(endX - 4, height - 6);
    ctx.lineTo(endX + 4, height - 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, height - 1, vp.width, 1);
}

/**
 * The event lane: a bar at each note's start for the lane's property (velocity, release: up from the
 * bottom; pan, fine pitch: up or down from the centre line).
 */
export function drawLane(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  height: number,
  notes: readonly Note[],
  style: NoteStyle,
  preview: ReadonlyMap<NoteId, Note> | null,
  lane: NoteLane,
): void {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, vp.width, height);
  ctx.fillStyle = theme.lineFaint;
  ctx.fillRect(0, 0, vp.width, 1);
  const bipolar = LANES[lane].bipolar;
  const usable = height - 6;
  const mid = 3 + usable / 2;
  if (bipolar) {
    ctx.fillStyle = theme.step;
    ctx.fillRect(0, vp.snap(mid), vp.width, 1);
    // Which way is which: right/left for pan, up/down for fine pitch.
    ctx.fillStyle = theme.textFaint;
    ctx.font = `500 ${fontPx(9)}px ${theme.font}`;
    ctx.textBaseline = 'top';
    ctx.fillText(lane === 'pan' ? 'R' : '+100 ct', 3, 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText(lane === 'pan' ? 'L' : '−100 ct', 3, height - 2);
  }
  const [t0, t1] = vp.visibleTicks();
  // Heads only where they don't merge into a wall (zoomed out, the stems alone read better).
  const heads = vp.pxPerTick * TICKS_PER_STEP >= 6;
  for (const raw of notes) {
    const n = preview?.get(raw.id) ?? raw;
    if (n.tick > t1) break;
    if (n.tick < t0 - 1) continue;
    const x = vp.tickToPx(n.tick);
    // A lollipop: a slim stem and a round head at the value.
    const color = style.selected.has(n.id) ? theme.noteSelected : style.color;
    const v = laneValue(n, lane);
    let head: number;
    ctx.fillStyle = heads ? alpha(color, 0.55) : color;
    if (bipolar) {
      const top = v >= 0 ? mid - (v * usable) / 2 : mid;
      const h = Math.max(1, (Math.abs(v) * usable) / 2);
      ctx.fillRect(x, top, 1.5, h);
      head = v >= 0 ? top : top + h;
    } else {
      const h = Math.max(1, v * usable);
      ctx.fillRect(x, height - 3 - h, 1.5, h + 3);
      head = height - 3 - h;
    }
    if (!heads) continue;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 0.75, Math.max(3, Math.min(height - 3, head)), 2.75, 0, Math.PI * 2);
    ctx.fill();
  }
}
