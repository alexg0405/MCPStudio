import { useEffect, useRef, type PointerEvent } from 'react';
import { themeColors } from '@agstudio/sdk/ui';
import {
  FRAME_HARMONICS,
  harmonicAmps,
  normalizeFrame,
  setHarmonic,
  type Frame,
} from '@agstudio/sdk/dsp/wavetable-frames';
import styles from './table-editor.module.css';

/** How many harmonics get a bar (the table keeps 256; the rest come from drawing, importing or the other tools). */
const BARS = 48;
const CANVAS_W = 1120;
const CANVAS_H = 200;
const LABEL_H = 22;

/** The strongest of all 256 harmonics: the height a full bar stands for. */
function strongest(frame: Frame): number {
  return Math.max(1e-9, ...harmonicAmps(frame, FRAME_HARMONICS));
}

function paintBars(canvas: HTMLCanvasElement, frame: Frame, fullScale: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const colors = themeColors();
  ctx.fillStyle = colors.well;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const amps = harmonicAmps(frame, BARS);
  const slot = CANVAS_W / BARS;
  const top = CANVAS_H - LABEL_H;
  ctx.font = `20px ${colors.font}`;
  ctx.textAlign = 'center';
  amps.forEach((amp, i) => {
    const h = Math.min(1, amp / fullScale) * (top - 6);
    ctx.fillStyle = amp > 0 ? colors.accent : colors.line;
    ctx.fillRect(i * slot + 3, top - Math.max(2, h), slot - 6, Math.max(2, h));
    if (i === 0 || (i + 1) % 8 === 0) {
      ctx.fillStyle = colors.textDim;
      ctx.fillText(String(i + 1), i * slot + slot / 2, CANVAS_H - 5);
    }
  });
}

interface HarmonicPadProps {
  frame: Frame;
  /** The edited frame once a drag ends (scaled so its peak is 1 again). */
  onCommit(frame: Frame): void;
}

/**
 * Additive sliders: one bar per harmonic (1 = the pitch itself, 2 = an octave up, 3 = an octave and a fifth…).
 * Press on a bar and drag up or down; dragging sideways sets each bar it passes. A bar keeps its harmonic's phase.
 * The frame is scaled back to a peak of 1 when you let go.
 */
export function HarmonicPad({ frame, onCommit }: HarmonicPadProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ frame: Frame; fullScale: number; lastBar: number } | null>(null);

  useEffect(() => {
    if (canvas.current) paintBars(canvas.current, frame, strongest(frame));
  }, [frame]);

  /** The bar under the mouse and the strength its height means. */
  const barAt = (e: PointerEvent<HTMLCanvasElement>, fullScale: number) => {
    const box = e.currentTarget.getBoundingClientRect();
    const bar = Math.max(0, Math.min(BARS - 1, Math.floor(((e.clientX - box.left) / box.width) * BARS)));
    const top = (CANVAS_H - LABEL_H) / CANVAS_H;
    const height = 1 - (e.clientY - box.top) / box.height / top;
    return { bar, amp: Math.max(0, Math.min(1, height)) * fullScale };
  };

  const setBars = (e: PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (!state || !canvas.current) return;
    const { bar, amp } = barAt(e, state.fullScale);
    // Sweeping sideways fast skips bars: set every bar between the last one and this one.
    const from = Math.min(state.lastBar, bar);
    const to = Math.max(state.lastBar, bar);
    for (let b = from; b <= to; b++) state.frame = setHarmonic(state.frame, b + 1, amp);
    state.lastBar = bar;
    paintBars(canvas.current, state.frame, state.fullScale);
  };

  return (
    <canvas
      ref={canvas}
      className={styles.bars}
      width={CANVAS_W}
      height={CANVAS_H}
      role="img"
      aria-label="Harmonic strengths of the selected frame: drag the bars"
      data-hint="Harmonic sliders: bar 1 is the pitch, 2 an octave up, 3 an octave and a fifth. Drag a bar up or down (sideways to set several); a full bar is the strongest harmonic. One undo step per drag"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const fullScale = strongest(frame);
        const { bar } = barAt(e, fullScale);
        drag.current = { frame, fullScale, lastBar: bar };
        setBars(e);
      }}
      onPointerMove={setBars}
      onPointerUp={(e) => {
        const state = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (state) onCommit(normalizeFrame(state.frame));
      }}
    />
  );
}
