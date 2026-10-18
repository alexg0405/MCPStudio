import { useEffect, useRef } from 'react';
import { themeColors } from '@agstudio/sdk/ui';
import { frameToWave, type Frame } from '@agstudio/sdk/dsp/wavetable-frames';
import styles from './table-editor.module.css';

const THUMB_W = 120;
const THUMB_H = 64;
/** Points of a thumbnail's trace (a cycle is drawn this coarsely: it is only a picture). */
const THUMB_POINTS = 128;

function Thumb({ frame, active }: { frame: Frame; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const colors = themeColors();
    const wave = frameToWave(frame, new Float32Array(THUMB_POINTS));
    ctx.fillStyle = colors.well;
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    ctx.strokeStyle = active ? colors.accent : colors.textDim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    wave.forEach((v, i) => {
      const x = (i / (THUMB_POINTS - 1)) * THUMB_W;
      const y = THUMB_H / 2 - (Math.max(-1.2, Math.min(1.2, v)) * (THUMB_H - 8)) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [frame, active]);
  return <canvas ref={canvas} className={styles.thumb} width={THUMB_W} height={THUMB_H} />;
}

interface FrameStripProps {
  frames: readonly Frame[];
  selected: number;
  onSelect(index: number): void;
  /** Where each oscillator that plays this table sits (0–1) and its label, drawn as a marker over the strip. */
  markers: readonly { position: number; label: string }[];
}

/**
 * The key frames side by side, left to right as the table's position goes from 0 to 100%. Click one to edit it. A
 * marker shows where each oscillator using the table is reading it.
 */
export function FrameStrip({ frames, selected, onSelect, markers }: FrameStripProps) {
  return (
    <div className={styles.strip} role="listbox" aria-label="Key frames of the table">
      {frames.map((frame, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          role="option"
          aria-selected={i === selected}
          className={`${styles.frame} ${i === selected ? styles.frameActive : ''}`}
          onClick={() => onSelect(i)}
          data-hint={`Frame ${i + 1} of ${frames.length}, at position ${Math.round((frames.length > 1 ? i / (frames.length - 1) : 0) * 100)}%: click to edit it`}
        >
          <Thumb frame={frame} active={i === selected} />
          <span className={styles.frameNumber}>{i + 1}</span>
        </button>
      ))}
      {markers.map((m) => (
        <span
          key={m.label}
          className={styles.marker}
          style={{ left: `${((frames.length > 1 ? m.position * (frames.length - 1) : 0) + 0.5) * (100 / frames.length)}%` }}
          data-hint={`${m.label} reads the table here (position ${Math.round(m.position * 100)}%)`}
        >
          {m.label}
        </span>
      ))}
    </div>
  );
}
