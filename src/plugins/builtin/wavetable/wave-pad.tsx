import { useEffect, useMemo, useRef, type PointerEvent } from 'react';
import { themeColors, type ThemeColors } from '@agstudio/sdk/ui';
import { drawStroke, frameFromWave, frameToWave, type Frame } from '@agstudio/sdk/dsp/wavetable-frames';
import styles from './table-editor.module.css';

/** Canvas size in device pixels (drawn at twice its CSS size so lines stay sharp on retina screens). */
const CANVAS_W = 1120;
const CANVAS_H = 340;
const LINE_WIDTH = 3;
/** Pixels kept free at the top and bottom, so a peak at full scale is not cut off. */
const VERTICAL_MARGIN = 20;
/** The drawing may overshoot full scale by this much before it is cut off at the canvas edge. */
const OVERSHOOT = 1.2;

/** The y pixel of a wave value (-1…1; up is louder). */
function yOf(value: number): number {
  return CANVAS_H / 2 - (value * (CANVAS_H - VERTICAL_MARGIN)) / 2;
}

/** The background: the zero line and faint lines at half scale. */
function paintGrid(ctx: CanvasRenderingContext2D, colors: ThemeColors): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = colors.well;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  for (const level of [-0.5, 0.5]) {
    ctx.beginPath();
    ctx.moveTo(0, yOf(level));
    ctx.lineTo(CANVAS_W, yOf(level));
    ctx.stroke();
  }
  ctx.strokeStyle = colors.lineStrong;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H / 2);
  ctx.lineTo(CANVAS_W, CANVAS_H / 2);
  ctx.stroke();
}

/** Draws one cycle as a line across the canvas. */
function traceWave(ctx: CanvasRenderingContext2D, data: Float32Array, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let x = 0; x < CANVAS_W; x++) {
    const value = data[Math.min(data.length - 1, Math.floor((x / CANVAS_W) * data.length))] as number;
    const y = yOf(Math.max(-OVERSHOOT, Math.min(OVERSHOOT, value)));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Paints one cycle with the neighbouring frames faintly behind it. */
function paintWave(canvas: HTMLCanvasElement, wave: Float32Array, ghosts: readonly Float32Array[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const colors = themeColors();
  paintGrid(ctx, colors);
  for (const ghost of ghosts) traceWave(ctx, ghost, colors.textFaint, 1);
  traceWave(ctx, wave, colors.accent, LINE_WIDTH);
}

interface WavePadProps {
  /** The table's key frames and the selected one (the one being drawn on). */
  frames: readonly Frame[];
  selected: number;
  /** A finished stroke: the frame as drawn. */
  onCommit(frame: Frame): void;
  /** An audio file dropped on the pad. */
  onDropFile(file: File): void;
}

/**
 * The drawing pad: press and drag to draw the shape of one cycle (left to right is time, up is louder); the stroke
 * is one undo step when you let go. The neighbouring key frames show faintly behind, to draw a morph by eye.
 */
export function WavePad({ frames, selected, onCommit, onDropFile }: WavePadProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ wave: Float32Array; x: number; y: number } | null>(null);
  const frame = frames[selected];
  const waves = useMemo(
    () => ({
      current: frame ? frameToWave(frame) : null,
      ghosts: [frames[selected - 1], frames[selected + 1]].flatMap((f) => (f ? [frameToWave(f)] : [])),
    }),
    [frames, selected, frame],
  );

  useEffect(() => {
    if (canvas.current && waves.current) paintWave(canvas.current, waves.current, waves.ghosts);
  }, [waves]);

  /** Mouse position as a point in the cycle: x 0–1, y −1…1 (up is 1). */
  const pointOf = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - box.left) / box.width,
      y: -(((e.clientY - box.top) / box.height) * 2 - 1) / ((CANVAS_H - VERTICAL_MARGIN) / CANVAS_H),
    };
  };

  const strokeTo = (e: PointerEvent<HTMLCanvasElement>) => {
    const state = drawing.current;
    if (!state || !canvas.current) return;
    const p = pointOf(e);
    drawStroke(state.wave, state.x, state.y, p.x, p.y);
    state.x = p.x;
    state.y = p.y;
    paintWave(canvas.current, state.wave, waves.ghosts);
  };

  return (
    <div className={styles.padBox}>
      <canvas
        ref={canvas}
        className={styles.pad}
        width={CANVAS_W}
        height={CANVAS_H}
        role="img"
        aria-label="The shape of the selected frame: draw on it"
        data-hint="Draw the wave: press and drag left to right (time within one cycle), up is louder. One undo step per stroke. Drop an audio file here to import it"
        onPointerDown={(e) => {
          if (e.button !== 0 || !waves.current) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = pointOf(e);
          drawing.current = { wave: Float32Array.from(waves.current), x: p.x, y: p.y };
          strokeTo(e);
        }}
        onPointerMove={strokeTo}
        onPointerUp={(e) => {
          const state = drawing.current;
          drawing.current = null;
          if (state) onCommit(frameFromWave(state.wave));
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          const file = e.dataTransfer.files[0];
          if (!file) return;
          e.preventDefault();
          onDropFile(file);
        }}
      />
    </div>
  );
}
