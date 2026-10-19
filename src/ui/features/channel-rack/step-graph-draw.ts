/** Drawing of the step graph editor: one bar per step for the property being edited (velocity, pan, release, pitch…). */
import type { Note } from '@core/model/types';
import { fitCanvas, readTheme, roundRectPath } from '../../timeline/canvas';
import type { StepLane } from '@app/stores/editor';
import { STEP_W, stepX } from './layout';
import { STEP_LANE_INFO, stepValue } from './steps';

/** The graph's height in px. */
export const GRAPH_H = 56;
/** The empty margin above and below the bars, in px. */
const GRAPH_MARGIN = 3;
/** Bars are never shorter than this, so a zero value still shows, in px. */
const MIN_BAR_PX = 2;

/** What the graph is drawn for: its size, the number of steps, the property shown and the channel's root note. */
export interface StepGraphView {
  width: number;
  stepCount: number;
  lane: StepLane;
  rootKey: number;
}

/**
 * Draws the graph for a channel's steps (`notes`, one per step or none) onto its canvas: a faint tile per step, and a bar
 * per step that is on. A property that can go both ways (pan, fine pitch) draws up or down from a middle line.
 */
export function drawStepGraph(canvas: HTMLCanvasElement, notes: readonly (Note | null | undefined)[], view: StepGraphView): void {
  const { width, stepCount, lane, rootKey } = view;
  const isBipolar = STEP_LANE_INFO[lane].bipolar;
  const ctx = fitCanvas(canvas, width, GRAPH_H);
  const theme = readTheme();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, GRAPH_H);
  const usable = GRAPH_H - 2 * GRAPH_MARGIN;
  const middleY = GRAPH_MARGIN + usable / 2;
  if (isBipolar) {
    ctx.fillStyle = theme.step;
    ctx.fillRect(0, Math.round(middleY), width, 1);
  }
  for (let i = 0; i < stepCount; i++) {
    const x = stepX(i);
    // Each step has a faint tile (every other group of four a little brighter), like the buttons.
    ctx.fillStyle = Math.floor(i / 4) % 2 ? theme.sheen : theme.lineFaint;
    ctx.beginPath();
    roundRectPath(ctx, x, 1, STEP_W, GRAPH_H - 2, 3);
    ctx.fill();
    const note = notes[i];
    if (!note) {
      ctx.fillStyle = theme.textFaint;
      ctx.fillRect(x + STEP_W / 2 - 1, GRAPH_H - 4, 2, 2);
      continue;
    }
    const value = stepValue(note, lane, rootKey);
    const barX = x + GRAPH_MARGIN;
    const barWidth = STEP_W - 2 * GRAPH_MARGIN;
    let top: number;
    let height: number;
    if (isBipolar) {
      height = Math.max(MIN_BAR_PX, (Math.abs(value) * usable) / 2);
      top = value >= 0 ? middleY - height : middleY;
    } else {
      height = Math.max(MIN_BAR_PX, value * usable);
      top = GRAPH_H - GRAPH_MARGIN - height;
    }
    ctx.fillStyle = theme.note;
    ctx.beginPath();
    roundRectPath(ctx, barX, top, barWidth, height, 2);
    ctx.fill();
    // The value's end as a lighter cap.
    ctx.fillStyle = theme.noteTop;
    ctx.fillRect(barX, isBipolar && value < 0 ? top + height - 1 : top, barWidth, 1);
  }
}
