import { useContext, useEffect, useEffectEvent, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { faderToGain, formatGain, gainToFader, UNITY_POSITION } from '@core/model/fader';
import { emitHint, ParamMenuContext, TouchAssist, useParamStatus } from '@agstudio/sdk/ui';
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
  /** Target key: right-click opens the param menu (automation, controller link…). */
  param?: string;
}

/** CSS offset of a fader position from the bottom: the cap centre moves within [PAD, h - PAD]. */
const bottomFor = (pos: number) => `calc(${FADER_PAD}px + (100% - ${FADER_CAP}px) * ${pos})`;

/**
 * Vertical mixer fader with the dB taper: drag (Shift = fine), wheel, double-click for 0 dB.
 * Controlled: the document owns the value.
 */
export function Fader({ value, label, onBegin, onChange, onEnd, onCommit, param }: FaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const openMenu = useContext(ParamMenuContext);
  const drag = useRef<{ pointerId: number; y: number; from: number; at: number; fine: boolean; travel: number } | null>(null);
  // A finger's fine modes: a second finger, or a first rest (a rest without a drag opens the param menu).
  const assist = useRef<TouchAssist | null>(null);
  assist.current ??= new TouchAssist({
    onFineChange: () => ref.current?.toggleAttribute('data-fine', assist.current?.isFine ?? false),
  });
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
    // A second finger on the fader is the fine mode (the assist hears it), not a new drag.
    if (drag.current && e.pointerType === 'touch' && e.pointerId !== drag.current.pointerId) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    assist.current?.start(e);
    const travel = Math.max(20, e.currentTarget.clientHeight - FADER_CAP);
    drag.current = { pointerId: e.pointerId, y: e.clientY, from: pos, at: pos, fine: e.shiftKey, travel };
    onBegin();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const phase = assist.current?.move(e) ?? 'dragging';
    if (phase === 'resting') return;
    const wantsFine = e.shiftKey || (assist.current?.isFine ?? false);
    // Re-anchor when a finger's drag starts, or when Shift (or a second finger) changes, so the cap doesn't jump.
    if (phase === 'started' || wantsFine !== d.fine) {
      d.y = e.clientY;
      d.from = d.at;
      d.fine = wantsFine;
    }
    const next = Math.min(1, Math.max(0, d.from + ((d.y - e.clientY) / d.travel) * (d.fine ? 0.1 : 1)));
    if (next === d.at) return;
    d.at = next;
    const gain = faderToGain(next);
    onChange(gain);
    emitHint(e.currentTarget, `${label}: ${formatGain(gain)}`);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onEnd();
    const restedAt = assist.current?.end();
    if (restedAt && e.type === 'pointerup' && param && openMenu) openMenu(param, { clientX: restedAt.x, clientY: restedAt.y });
  };

  const text = formatGain(value);
  // Automated (or being recorded): a dot on the fader, and the hint says by what.
  const status = useParamStatus(param);
  const hint = `${label}: ${text}. Drag (Shift or a second finger = fine) or scroll; double-click or double-tap for 0 dB`;
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
      data-hint={status ? `${hint} · ${status.hint}` : hint}
      data-touch-own=""
      onContextMenu={
        param && openMenu
          ? (e) => {
              e.preventDefault();
              openMenu(param, e);
            }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(1)}
    >
      <div className={styles.faderTrack} />
      <div className={styles.faderFill} style={{ height: `calc((100% - ${FADER_CAP}px) * ${pos})` }} />
      <div className={styles.faderUnity} style={{ bottom: bottomFor(UNITY_POSITION) }} />
      <div className={styles.faderCap} style={{ bottom: bottomFor(pos), marginBottom: -FADER_PAD }} />
      {status && <i className={styles.faderStatus} data-kind={status.kind} aria-hidden />}
    </div>
  );
}
