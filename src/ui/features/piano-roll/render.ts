/**
 * Piano roll drawing. Pure functions of (context, viewport, data): the controller decides when each
 * layer needs redrawing. All coordinates are CSS pixels.
 */
import type { NoteLane } from '@app/stores/editor';
import type { Note, NoteId, Tick, TimeSignature } from '@core/model/types';
import { keyName, ticksPerBar, ticksPerBeat, TICKS_PER_STEP } from '@core/time/ppq';
import { isBlackKey, shade, type TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { laneValue, LANES } from './lanes';

export const keyForRow = (row: number) => 127 - row;
export const rowForKey = (key: number) => 127 - key;

/** The song key as the grid shows it: which pitch classes are in the scale, and the tonic. */
export interface ScaleRows {
  /** Index = pitch class (key % 12). */
  mask: readonly boolean[];
  root: number;
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
): void {
  const { width, height } = vp;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const [r0, r1] = vp.visibleRows();
  for (let row = r0; row <= r1; row++) {
    const key = keyForRow(row);
    const y = vp.rowToY(row);
    if (scale) {
      const pc = key % 12;
      ctx.fillStyle = !scale.mask[pc]
        ? 'rgba(0, 0, 0, 0.32)'
        : pc === scale.root
          ? 'rgba(255, 154, 60, 0.12)'
          : 'rgba(255, 255, 255, 0.035)';
      ctx.fillRect(0, y, width, vp.rowHeight);
    } else if (isBlackKey(key)) {
      ctx.fillStyle = theme.bgAlt;
      ctx.fillRect(0, y, width, vp.rowHeight);
    }
    // Octave boundary (between B and C) is drawn stronger.
    ctx.fillStyle = key % 12 === 0 ? theme.bar : theme.step;
    ctx.fillRect(0, y + vp.rowHeight - 1, width, 1);
  }

  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  const lines: [Tick, string][] = [];
  if (TICKS_PER_STEP * vp.pxPerTick >= 6) lines.push([TICKS_PER_STEP, theme.step]);
  if (beat * vp.pxPerTick >= 6) lines.push([beat, theme.beat]);
  lines.push([bar * vp.pxPerTick >= 4 ? bar : bar * 4, theme.bar]);
  for (const [every, color] of lines) {
    ctx.fillStyle = color;
    for (let t = Math.floor(t0 / every) * every; t <= t1; t += every) {
      const x = Math.round(vp.tickToX(t));
      ctx.fillRect(x, 0, 1, height);
    }
  }

  // Shade everything after the pattern's end.
  const endX = vp.tickToX(patternEnd);
  if (endX < width) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height);
  }
}

export interface NoteStyle {
  color: string;
  selected: ReadonlySet<NoteId>;
}

/** Notes overlapping the view. `skip` hides originals that are being dragged. */
export function drawNotes(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  notes: readonly Note[],
  style: NoteStyle,
  opts: { skip?: ReadonlySet<NoteId>; alpha?: number } = {},
): void {
  const [t0, t1] = vp.visibleTicks();
  const [r0, r1] = vp.visibleRows();
  const h = vp.rowHeight;
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.font = `${Math.min(11, h - 3)}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const n of notes) {
    if (n.tick > t1) break;
    if (n.tick + n.length < t0 || opts.skip?.has(n.id)) continue;
    const row = rowForKey(n.key);
    if (row < r0 - 1 || row > r1 + 1) continue;
    const x = vp.tickToX(n.tick);
    const w = Math.max(2, n.length * vp.pxPerTick - 1);
    const y = vp.rowToY(row);
    const selected = style.selected.has(n.id);
    const base = selected ? theme.noteSelected : style.color;
    // Velocity shows as brightness.
    ctx.fillStyle = shade(base, (n.velocity - 0.78) * 0.5);
    ctx.fillRect(x, y + 1, w, h - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, y + h - 2, w, 1);
    ctx.fillRect(x + w - 1, y + 1, 1, h - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, y + 1, w, 1);
    if (n.muted) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x, y + 1, w, h - 2);
    }
    if (w > 26 && h >= 10) {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(keyName(n.key), x + 4, y + h / 2 + 0.5, w - 6);
    }
  }
  ctx.globalAlpha = 1;
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
  ctx.fillStyle = theme.ghost;
  for (const n of notes) {
    if (n.tick > t1) break;
    if (n.tick + n.length < t0) continue;
    const y = vp.rowToY(rowForKey(n.key));
    if (y < -h || y > vp.height) continue;
    ctx.fillRect(vp.tickToX(n.tick), y + 2, Math.max(2, n.length * vp.pxPerTick - 1), h - 4);
  }
}

/** Piano keyboard on the left. `pressed` keys are highlighted; with a song key, scale keys get a dot. */
export function drawKeys(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  width: number,
  pressed: ReadonlySet<number>,
  rootKey: number | null,
  scale: ScaleRows | null = null,
): void {
  ctx.fillStyle = theme.keyBlack;
  ctx.fillRect(0, 0, width, vp.height);
  const [r0, r1] = vp.visibleRows();
  const h = vp.rowHeight;
  ctx.font = `${Math.min(10, h - 3)}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (let row = r0; row <= r1; row++) {
    const key = keyForRow(row);
    const y = vp.rowToY(row);
    const black = isBlackKey(key);
    const isPressed = pressed.has(key);
    if (black) {
      ctx.fillStyle = isPressed ? theme.accent : '#22282d';
      ctx.fillRect(0, y, width * 0.62, h);
      ctx.fillStyle = theme.keyWhite;
      ctx.fillRect(width * 0.62, y, width * 0.38, h);
    } else {
      ctx.fillStyle = isPressed ? theme.accent : theme.keyWhite;
      ctx.fillRect(0, y, width, h);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, y + h - 1, width, 1);
    if (key === rootKey) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(width - 4, y + 1, 3, h - 2);
    }
    if (scale?.mask[key % 12] && h >= 6) {
      // A dot at the left end of the scale's keys (orange for the root), clear of the octave labels.
      const r = Math.min(2.5, (h - 3) / 2);
      ctx.beginPath();
      ctx.arc(7, y + h / 2, r, 0, Math.PI * 2);
      ctx.fillStyle = key % 12 === scale.root ? theme.accent : black ? '#aab4bc' : '#59646d';
      ctx.fill();
    }
    if (key % 12 === 0 && h >= 8) {
      ctx.fillStyle = '#4a5560';
      ctx.fillText(keyName(key), width * 0.64, y + h / 2 + 0.5);
    }
  }
}

/** Bar numbers and beat ticks above the grid. */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  theme: TimelineTheme,
  ts: TimeSignature,
  height: number,
  patternEnd: Tick,
): void {
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, vp.width, height);
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const [t0, t1] = vp.visibleTicks();
  const barPx = bar * vp.pxPerTick;
  const labelEvery = barPx >= 40 ? 1 : barPx >= 20 ? 2 : barPx >= 8 ? 4 : 16;
  ctx.font = `10px ${theme.font}`;
  ctx.textBaseline = 'top';
  if (beat * vp.pxPerTick >= 8) {
    ctx.fillStyle = theme.textDim;
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat) {
      if (t % bar === 0) continue;
      ctx.fillRect(Math.round(vp.tickToX(t)), height - 4, 1, 4);
    }
  }
  for (let b = Math.floor(t0 / bar); b * bar <= t1; b++) {
    const x = Math.round(vp.tickToX(b * bar));
    ctx.fillStyle = theme.textDim;
    ctx.fillRect(x, height - 8, 1, 8);
    if (b % labelEvery === 0) {
      ctx.fillStyle = theme.text;
      ctx.fillText(String(b + 1), x + 3, 3);
    }
  }
  const endX = vp.tickToX(patternEnd);
  if (endX >= 0 && endX <= vp.width) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.moveTo(endX, height);
    ctx.lineTo(endX - 5, height - 6);
    ctx.lineTo(endX + 5, height - 6);
    ctx.fill();
  }
  ctx.fillStyle = theme.border;
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
  ctx.fillStyle = theme.border;
  ctx.fillRect(0, 0, vp.width, 1);
  const bipolar = LANES[lane].bipolar;
  const usable = height - 6;
  const mid = 3 + usable / 2;
  if (bipolar) {
    ctx.fillStyle = theme.step;
    ctx.fillRect(0, Math.round(mid), vp.width, 1);
    // Which way is which: right/left for pan, up/down for fine pitch.
    ctx.fillStyle = theme.textDim;
    ctx.font = `9px ${theme.font}`;
    ctx.textBaseline = 'top';
    ctx.fillText(lane === 'pan' ? 'R' : '+100 ct', 3, 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText(lane === 'pan' ? 'L' : '−100 ct', 3, height - 2);
  }
  const [t0, t1] = vp.visibleTicks();
  for (const raw of notes) {
    const n = preview?.get(raw.id) ?? raw;
    if (n.tick > t1) break;
    if (n.tick < t0 - 1) continue;
    const x = Math.round(vp.tickToX(n.tick));
    ctx.fillStyle = style.selected.has(n.id) ? theme.noteSelected : style.color;
    const v = laneValue(n, lane);
    if (bipolar) {
      const top = v >= 0 ? mid - (v * usable) / 2 : mid;
      const h = Math.max(1, (Math.abs(v) * usable) / 2);
      ctx.fillRect(x, top, 2, h);
      ctx.fillRect(x - 2, v >= 0 ? top : top + h - 2, 6, 2);
    } else {
      const h = Math.max(1, v * usable);
      ctx.fillRect(x, height - 3 - h, 2, h + 3);
      ctx.fillRect(x - 2, height - 3 - h, 6, 2);
    }
  }
}
