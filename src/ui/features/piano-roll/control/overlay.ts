/** The overlay canvas over the notes: what follows the pointer and is not part of the pattern yet. */
import { alpha, fitCanvas, readTheme, roundRectPath, type TimelineTheme, fontPx } from '../../../timeline/canvas';
import { drawKeyCursor } from '../../../timeline/key-cursor/draw';
import { drawSelectionBox } from '../../../timeline/selection-box';
import { rowForKey } from '../render';
import type { PianoRollContext } from './context';
import { cursorBox } from './key-cursor';
import { editTarget } from './target';

/** The stamp's label sits this far above its topmost note (px). */
const STAMP_LABEL_RISE = 19;

/** Redraws the overlay canvas (dirty frames only). */
export function drawOverlay(ctx: PianoRollContext): void {
  const { vp, els, state } = ctx;
  const canvas = fitCanvas(els.overlay, vp.width, vp.height);
  canvas.clearRect(0, 0, vp.width, vp.height);
  const theme = readTheme();
  const drag = state.drag;
  if (drag?.kind === 'marquee') {
    drawSelectionBox(canvas, vp, theme, drag);
  } else if (state.hover && !drag) {
    drawHoverEdge(ctx, canvas, theme);
  } else if (state.stampHover && !drag) {
    drawChordStamp(ctx, canvas, theme);
  }
  // The keyboard cursor goes on top of everything, and only while the grid has the keyboard.
  if (state.keyboard.isActive) drawKeyCursor(canvas, theme, cursorBox(ctx, editTarget(ctx)));
}

/** The note under the pointer lifts a little (a brighter rounded edge); with the slice tool, the cut line shows too. */
function drawHoverEdge(ctx: PianoRollContext, canvas: CanvasRenderingContext2D, theme: TimelineTheme): void {
  const { vp, state } = ctx;
  if (!state.hover) return;
  const note = state.hover.note;
  const x = vp.tickToPx(note.tick);
  const y = vp.rowToY(rowForKey(note.key));
  canvas.strokeStyle = alpha(theme.text, 0.75);
  canvas.beginPath();
  roundRectPath(canvas, x + 0.5, y + 1.5, Math.max(2, note.length * vp.pxPerTick - 2), vp.rowHeight - 3, 3);
  canvas.stroke();
  if (ctx.s.editor.getState().pianoRoll.tool === 'slice') {
    canvas.fillStyle = theme.danger;
    canvas.fillRect(vp.snap(state.sliceLineX), y, 1, vp.rowHeight);
  }
}

/** The chord the draw tool would stamp here: dashed outlines and its name above them. */
function drawChordStamp(ctx: PianoRollContext, canvas: CanvasRenderingContext2D, theme: TimelineTheme): void {
  const { vp, state } = ctx;
  if (!state.stampHover) return;
  const { tick, length, keys, name } = state.stampHover;
  const x = vp.tickToPx(tick);
  const width = Math.max(6, vp.tickToPx(tick + length) - x - 1);
  canvas.setLineDash([3, 2]);
  canvas.strokeStyle = alpha(theme.accent, 0.85);
  canvas.fillStyle = alpha(theme.accent, 0.12);
  let top = Infinity;
  for (const key of keys) {
    const y = vp.rowToY(rowForKey(key));
    top = Math.min(top, y);
    canvas.beginPath();
    roundRectPath(canvas, x + 0.5, y + 1.5, width, vp.rowHeight - 3, 3);
    canvas.fill();
    canvas.stroke();
  }
  canvas.setLineDash([]);
  if (!name || !Number.isFinite(top)) return;
  canvas.font = `600 ${fontPx(11)}px ${theme.font}`;
  canvas.textBaseline = 'middle';
  const labelWidth = canvas.measureText(name).width + 14;
  canvas.fillStyle = theme.glass;
  canvas.beginPath();
  roundRectPath(canvas, x, top - STAMP_LABEL_RISE, labelWidth, 16, 8);
  canvas.fill();
  canvas.strokeStyle = theme.accentDim;
  canvas.stroke();
  canvas.fillStyle = theme.accent;
  canvas.fillText(name, x + 7, top - 10.5);
}
