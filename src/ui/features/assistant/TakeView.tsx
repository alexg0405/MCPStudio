import { fontPx } from '../../timeline/canvas';
import { useLayoutEffect, useRef } from 'react';
import type { Take } from '@app/assistant/assistant';
import { noteName } from '@app/assistant/context';
import styles from './Assistant.module.css';

/** What the analysis heard: hits on rows (hat, snare, kick), hummed notes placed by pitch. */
export function TakeView({ take }: { take: Take }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(canvas);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    ctx.fillStyle = color('--ag-surface-inset', '#0e0f11');
    ctx.fillRect(0, 0, w, h);
    const bar = color('--ag-line-strong', 'rgba(255, 255, 255, 0.1)');
    const beat = color('--ag-line-faint', 'rgba(255, 255, 255, 0.05)');

    const steps = take.bars * 16;
    const x = (step: number) => (step / steps) * w;
    for (let s = 0; s <= steps; s++) {
      if (s % 4 !== 0) continue;
      ctx.fillStyle = s % 16 === 0 ? bar : beat;
      ctx.fillRect(Math.round(x(s)), 0, 1, h);
    }

    const tonal = take.events.filter((e) => e.kind === 'tonal' && e.pitch !== null);
    const pitches = tonal.map((e) => e.pitch as number);
    const lo = Math.min(...pitches, 127);
    const hi = Math.max(...pitches, 0);
    const span = Math.max(6, hi - lo);
    const rowY = { hat: h * 0.18, snare: h * 0.5, kick: h * 0.82 } as const;
    ctx.font = `600 ${fontPx(9)}px ${color('--ag-font', 'sans-serif')}`;
    ctx.textBaseline = 'middle';
    for (const e of take.events) {
      const ex = x(e.step);
      const alpha = 0.45 + 0.55 * e.strength;
      if (e.kind === 'tonal') {
        const p = e.pitch ?? lo;
        const y = h - 8 - ((p - lo) / span) * (h - 16);
        const ew = Math.max(3, x(e.step + e.lengthSteps) - ex - 1);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color('--ag-led', '#9fd38f');
        ctx.fillRect(ex, y - 3, ew, 6);
        if (e.pitchEnd !== null && Math.abs(e.pitchEnd - p) >= 1) {
          const y2 = h - 8 - ((e.pitchEnd - lo) / span) * (h - 16);
          ctx.strokeStyle = ctx.fillStyle;
          ctx.beginPath();
          ctx.moveTo(ex + ew * 0.6, y);
          ctx.lineTo(ex + ew, y2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (ew > 22) {
          ctx.fillStyle = color('--ag-on-light', '#111214');
          ctx.fillText(noteName(Math.round(p)), ex + 2, y);
        }
      } else {
        const y = rowY[e.kind];
        const r = e.kind === 'kick' ? 5 : e.kind === 'snare' ? 4 : 3;
        ctx.globalAlpha = alpha;
        ctx.fillStyle =
          e.kind === 'kick'
            ? color('--ag-accent', '#c9a45c')
            : e.kind === 'snare'
              ? color('--ag-danger', '#e0675a')
              : color('--ag-select', '#8eb4e3');
        ctx.beginPath();
        ctx.arc(ex + 3, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }, [take]);

  return (
    <canvas
      ref={ref}
      className={styles.take}
      data-hint="Your take on the grid: gold = kicks, red = snares, blue = hats, green = hummed notes"
    />
  );
}
