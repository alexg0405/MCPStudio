/**
 * What the grid, notes, ruler and event lane layers draw. Each is drawn into a picture wider than the view
 * (timeline/panned.ts) and only when it is stale (an edit, a zoom, a theme change), not on every frame.
 */
import type { ChannelId } from '@core/model/types';
import { notesSorted } from '@core/query/queries';
import { readTheme } from '../../../timeline/canvas';
import type { PanDraw } from '../../../timeline/panned';
import type { Viewport } from '../../../timeline/viewport';
import { RULER_HEIGHT } from '../layout';
import { drawGhosts, drawGrid, drawLane, drawNotes, drawRuler } from '../render';
import type { PianoRollContext } from './context';
import { chordBandsOf, editTarget, patternEnd, scaleRowsOf, selectedNoteIds } from './target';

/** The four drawing functions of the panned layers. */
export interface LayerDrawers {
  grid: PanDraw;
  notes: PanDraw;
  ruler: PanDraw;
  lane: PanDraw;
}

/**
 * Builds the drawing functions once. `PannedLayer.paint` takes one every frame, so an inline arrow would be a closure per
 * frame. They read the state they draw when they run, which is only when the layer is stale.
 */
export function createLayerDrawers(ctx: PianoRollContext): LayerDrawers {
  return {
    grid: (canvas, wide) => drawGridLayer(ctx, canvas, wide),
    notes: (canvas, wide) => drawNotesLayer(ctx, canvas, wide),
    ruler: (canvas, wide) => drawRulerLayer(ctx, canvas, wide),
    lane: (canvas, wide) => drawLaneLayer(ctx, canvas, wide),
  };
}

function drawGridLayer(ctx: PianoRollContext, canvas: CanvasRenderingContext2D, wide: Viewport): void {
  const target = editTarget(ctx);
  const timeSig = target.project.transport.timeSig;
  drawGrid(canvas, wide, readTheme(), timeSig, patternEnd(target), scaleRowsOf(ctx, target), chordBandsOf(ctx, target));
}

function drawRulerLayer(ctx: PianoRollContext, canvas: CanvasRenderingContext2D, wide: Viewport): void {
  const target = editTarget(ctx);
  drawRuler(canvas, wide, readTheme(), target.project.transport.timeSig, RULER_HEIGHT, patternEnd(target));
}

function drawLaneLayer(ctx: PianoRollContext, canvas: CanvasRenderingContext2D, wide: Viewport): void {
  const target = editTarget(ctx);
  const theme = readTheme();
  const lane = ctx.s.editor.getState().pianoRoll.lane;
  const style = { color: theme.note, selected: selectedNoteIds(ctx) };
  drawLane(canvas, wide, theme, wide.height, target.notes, style, ctx.state.preview, lane);
}

function drawNotesLayer(ctx: PianoRollContext, canvas: CanvasRenderingContext2D, wide: Viewport): void {
  const { state } = ctx;
  const target = editTarget(ctx);
  const theme = readTheme();
  canvas.clearRect(0, 0, wide.width, wide.height);
  if (ctx.s.editor.getState().pianoRoll.ghosts && target.pattern) {
    // for-in, not Object.entries: no array of pairs.
    for (const channelId in target.pattern.notes) {
      const notes = target.pattern.notes[channelId as ChannelId];
      if (channelId !== target.channelId && notes) drawGhosts(canvas, wide, theme, notesSorted(notes));
    }
  }
  const style = { color: theme.note, selected: selectedNoteIds(ctx) };
  const preview = state.preview;
  if (preview) {
    // The notes being moved or resized are drawn from the preview; the originals are hidden.
    const drag = state.drag;
    const hidesOriginals = (drag?.kind === 'move' && !drag.duplicate) || drag?.kind === 'resize';
    drawNotes(canvas, wide, theme, target.notes, style, { skip: hidesOriginals ? new Set(preview.keys()) : new Set() });
    const shown = [...preview.values()].sort((a, b) => a.tick - b.tick);
    drawNotes(canvas, wide, theme, shown, { color: theme.note, selected: new Set(shown.map((note) => note.id)) });
  } else {
    drawNotes(canvas, wide, theme, target.notes, style);
  }
  if (state.previewAdds.length > 0) {
    drawNotes(canvas, wide, theme, state.previewAdds, {
      color: theme.note,
      selected: new Set(state.previewAdds.map((note) => note.id)),
    });
  }
}
