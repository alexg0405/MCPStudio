import {
  memo,
  useContext,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { formatValue, fromNormalized, toNormalized, type ParamSpec, type ParamValue } from '../params';
import { emitHint } from './hint';
import { ParamFollowContext, ParamMenuContext, useParamStatus } from './param-menu';
import styles from './controls.module.css';

export interface KnobProps {
  spec: ParamSpec;
  value: ParamValue;
  label?: string;
  size?: number;
  /** Draw the value arc from the centre (pan, detune). */
  bipolar?: boolean;
  /** Arc colour (defaults to the theme accent). */
  color?: string;
  disabled?: boolean;
  /** Display text for a value (hint bar); defaults to the spec's formatting. */
  format?(value: ParamValue): string;
  /** Continuous edit lifecycle (one undo step per drag). */
  onBegin?(): void;
  onChange(value: ParamValue): void;
  onEnd?(): void;
  /** One-shot edits (wheel, double-click reset). Falls back to begin/change/end. */
  onCommit?(value: ParamValue): void;
  /** The param's id: right-click opens the host's param menu (automation, controller link…). */
  param?: string;
  /** What the knob does, added to its hint after the value ("Cutoff: 1.20 kHz — How bright it sounds"). */
  hint?: string;
}

const START = -135;
const SWEEP = 270;
/** Pixels of vertical drag for the full range. */
const TRAVEL = 200;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (Math.abs(to - from) < 0.01) return '';
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} ${sweep} ${b.x} ${b.y}`;
}

/**
 * Rotary knob: a stone body with the value as an accent arc around it (from the middle when
 * `bipolar`). Drag vertically (Shift = fine), double-click to reset, wheel to nudge.
 * Controlled: the host owns the value. Memoized: a host that passes stable handlers (useGestureEdit does) and
 * stable `format`/`spec` does not re-render the knob when only something else on it changed.
 */
export const Knob = memo(function Knob({
  spec,
  value,
  label,
  size = 28,
  bipolar,
  color,
  disabled,
  format = (v) => formatValue(spec, v),
  onBegin,
  onChange,
  onEnd,
  onCommit,
  param,
  hint,
}: KnobProps) {
  const drag = useRef<{ startY: number; startN: number; fine: boolean; n: number } | null>(null);
  const openMenu = useContext(ParamMenuContext);
  const follow = useContext(ParamFollowContext);
  const arcRef = useRef<SVGPathElement>(null);
  const pointerRef = useRef<SVGLineElement>(null);
  const n = toNormalized(spec, value);
  const deg = START + n * SWEEP;
  const mid = START + SWEEP / 2;
  const center = size / 2;
  // The value ring sits around a stone body; the pointer is drawn on the body.
  const stroke = Math.max(2, Math.round(size * 0.075 * 2) / 2);
  const r = size / 2 - stroke / 2 - 0.5;
  const bodyR = Math.max(4, r - stroke / 2 - 2.25);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // While automation drives the param, draw its value (imperatively: no React render per frame).
  useEffect(() => {
    if (!param || !follow) return;
    let shown: number | null = null;
    const paint = (norm: number) => {
      const d = START + norm * SWEEP;
      arcRef.current?.setAttribute(
        'd',
        bipolar ? arc(center, center, r, Math.min(mid, d), Math.max(mid, d)) : arc(center, center, r, START, d),
      );
      const a = polar(center, center, bodyR * 0.3, d);
      const b = polar(center, center, bodyR - 1.25, d);
      pointerRef.current?.setAttribute('x1', String(a.x));
      pointerRef.current?.setAttribute('y1', String(a.y));
      pointerRef.current?.setAttribute('x2', String(b.x));
      pointerRef.current?.setAttribute('y2', String(b.y));
    };
    return follow(param, (v) => {
      if (v === null) {
        if (shown !== null) paint(toNormalized(spec, valueRef.current));
        shown = null;
        return;
      }
      const next = toNormalized(spec, v);
      if (next === shown) return;
      shown = next;
      paint(next);
    });
  }, [param, follow, spec, bipolar, center, r, bodyR, mid]);
  // Automated (or being recorded): a small dot, and the hint says by what.
  const status = useParamStatus(param);
  const valued = `${label ?? spec.label ?? ''}${label || spec.label ? ': ' : ''}${format(value)}`;
  const plain = hint ? `${valued} — ${hint}` : valued;
  const text = status ? `${plain} · ${status.hint}` : plain;

  const commit = (v: ParamValue) => {
    if (onCommit) onCommit(v);
    else {
      onBegin?.();
      onChange(v);
      onEnd?.();
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startN: n, fine: e.shiftKey, n };
    // The held look (brighter body and arc) without a React render.
    e.currentTarget.setAttribute('data-dragging', '');
    onBegin?.();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (e.shiftKey !== d.fine) {
      // Re-anchor when Shift changes so the knob doesn't jump.
      d.startY = e.clientY;
      d.startN = d.n;
      d.fine = e.shiftKey;
    }
    const delta = ((d.startY - e.clientY) / TRAVEL) * (d.fine ? 0.1 : 1);
    const next = Math.min(1, Math.max(0, d.startN + delta));
    if (next === d.n) return;
    d.n = next;
    const v = fromNormalized(spec, next);
    onChange(v);
    emitHint(e.currentTarget, `${label ?? spec.label ?? ''} ${format(v)}`.trim());
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.removeAttribute('data-dragging');
    e.currentTarget.releasePointerCapture(e.pointerId);
    onEnd?.();
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step =
      spec.type === 'enum'
        ? 1 / Math.max(1, spec.options.length - 1)
        : spec.type === 'int'
          ? 1 / Math.max(1, spec.max - spec.min)
          : 0.02;
    const next = Math.min(1, Math.max(0, n + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 0.25 : 1)));
    if (next !== n) commit(fromNormalized(spec, next));
  };

  return (
    <div
      className={`${styles.knob} ${disabled ? styles.disabled : ''}`}
      style={{ width: size, height: size }}
      role="slider"
      aria-label={label ?? spec.label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={n}
      aria-valuetext={format(value)}
      data-hint={text}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => !disabled && commit(spec.default)}
      onContextMenu={
        param && openMenu
          ? (e) => {
              e.preventDefault();
              openMenu(param, e);
            }
          : undefined
      }
      onWheel={onWheel}
    >
      <span className={styles.knobBody} style={{ inset: center - bodyR }} aria-hidden />
      <svg className={styles.knobSvg} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <path d={arc(center, center, r, START, START + SWEEP)} className={styles.knobTrack} strokeWidth={stroke} />
        {bipolar && <circle cx={center} cy={center - r} r={stroke * 0.42} className={styles.knobCenter} />}
        <path
          ref={arcRef}
          d={
            bipolar
              ? arc(center, center, r, Math.min(mid, deg), Math.max(mid, deg))
              : arc(center, center, r, START, deg)
          }
          className={styles.knobArc}
          strokeWidth={stroke}
          style={color ? { stroke: color } : undefined}
        />
        <line
          ref={pointerRef}
          x1={polar(center, center, bodyR * 0.3, deg).x}
          y1={polar(center, center, bodyR * 0.3, deg).y}
          x2={polar(center, center, bodyR - 1.25, deg).x}
          y2={polar(center, center, bodyR - 1.25, deg).y}
          className={styles.knobPointer}
        />
      </svg>
      {status && <i className={styles.statusDot} data-kind={status.kind} aria-hidden />}
    </div>
  );
});
