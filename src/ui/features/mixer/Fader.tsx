import { useEffect, useEffectEvent, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { faderToGain, formatGain, gainToFader, UNITY_POSITION } from '@core/model/fader';
import { emitHint } from '@agstudio/sdk/ui';
import { FADER_CAP, FADER_PAD } from './scale';
import styles from './Mixer.module.css';

/** Travel per wheel notch (Shift: a quarter of it). */
const WHEEL_STEP = 0.01;

export interface FaderProps {
  /** Linear gain. */
  value: number;
  label: string;
  onBegin(): void;
  onChange(gain: number): void;
  onEnd(): void;
  /** One-shot edits (wheel, double-click reset). */
  onCommit(gain: number): void;
}

/** CSS offset of a fader position from the bottom: the cap centre moves within [PAD, h - PAD]. */
const bottomFor = (pos: number) => `calc(${FADER_PAD}px + (100% - ${FADER_CAP}px) * ${pos})`;

/**
 * Vertical mixer fader with the dB taper: drag (Shift = fine), wheel, double-click for 0 dB.
 * Controlled: the document owns the value.
 */
export function Fader({ value, label, onBegin, onChange, onEnd, onCommit }: FaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; from: number; at: number; fine: boolean; travel: number } | null>(null);
  const pos = gainToFader(value);
  // Wheel steps accumulate here, so several events before the next render all count.
  const wheelPos = useRef(pos);
  useEffect(() => {
    wheelPos.current = pos;
  }, [pos]);

  // React's onWheel is passive; a native listener can stop the mixer from scrolling instead.
  const onWheel = useEffectEvent((e: WheelEvent) => {
    e.preventDefault();
    const step = WHEEL_STEP * (e.shiftKey ? 0.25 : 1) * (e.deltaY < 0 ? 1 : -1);
    const next = Math.min(1, Math.max(0, wheelPos.current + step));
    if (next === wheelPos.current) return;
    wheelPos.current = next;
    onCommit(faderToGain(next));
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => onWheel(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const travel = Math.max(20, e.currentTarget.clientHeight - FADER_CAP);
    drag.current = { y: e.clientY, from: pos, at: pos, fine: e.shiftKey, travel };
    onBegin();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (e.shiftKey !== d.fine) {
      // Re-anchor when Shift changes so the cap doesn't jump.
      d.y = e.clientY;
      d.from = d.at;
      d.fine = e.shiftKey;
    }
    const next = Math.min(1, Math.max(0, d.from + ((d.y - e.clientY) / d.travel) * (d.fine ? 0.1 : 1)));
    if (next === d.at) return;
    d.at = next;
    const gain = faderToGain(next);
    onChange(gain);
    emitHint(e.currentTarget, `${label}: ${formatGain(gain)}`);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onEnd();
  };

  const text = formatGain(value);
  return (
    <div
      ref={ref}
      className={styles.fader}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={pos}
      aria-valuetext={text}
      data-hint={`${label}: ${text}. Drag (Shift = fine) or scroll; double-click for 0 dB`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(1)}
    >
      <div className={styles.faderTrack} />
      <div className={styles.faderUnity} style={{ bottom: bottomFor(UNITY_POSITION) }} />
      <div className={styles.faderCap} style={{ bottom: bottomFor(pos), marginBottom: -FADER_PAD }} />
    </div>
  );
}
