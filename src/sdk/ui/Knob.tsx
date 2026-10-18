import { memo, useContext, useEffect, useRef, type RefObject } from 'react';
import { formatValue, toNormalized, type ParamSpec, type ParamValue } from '../params';
import { knobMetrics, pointerEnds, trackPath, valueArcPath, type KnobMetrics } from './knob-geometry';
import { useKnobGestures } from './knob-gestures';
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

/** Moves the drawn arc and pointer to a knob position 0-1 (imperatively: no React render per frame). */
function paintKnob(
  arcEl: SVGPathElement | null,
  pointerEl: SVGLineElement | null,
  position: number,
  metrics: KnobMetrics,
  bipolar: boolean | undefined,
): void {
  arcEl?.setAttribute('d', valueArcPath(position, metrics, bipolar));
  const ends = pointerEnds(position, metrics);
  pointerEl?.setAttribute('x1', String(ends.x1));
  pointerEl?.setAttribute('y1', String(ends.y1));
  pointerEl?.setAttribute('x2', String(ends.x2));
  pointerEl?.setAttribute('y2', String(ends.y2));
}

/**
 * While automation drives the param, draws its value on the knob from the host's frame loop; when it
 * lets go, the knob goes back to the param's own value.
 */
function useAutomationFollow(
  param: string | undefined,
  spec: ParamSpec,
  value: ParamValue,
  bipolar: boolean | undefined,
  metrics: KnobMetrics,
  arcRef: RefObject<SVGPathElement | null>,
  pointerRef: RefObject<SVGLineElement | null>,
): void {
  const follow = useContext(ParamFollowContext);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const { center, radius, bodyRadius } = metrics;
  useEffect(() => {
    if (!param || !follow) return;
    const drawn: KnobMetrics = { center, stroke: 0, radius, bodyRadius };
    let shown: number | null = null;
    const paint = (position: number) => paintKnob(arcRef.current, pointerRef.current, position, drawn, bipolar);
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
  }, [param, follow, spec, bipolar, center, radius, bodyRadius, arcRef, pointerRef]);
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
  const openMenu = useContext(ParamMenuContext);
  const arcRef = useRef<SVGPathElement>(null);
  const pointerRef = useRef<SVGLineElement>(null);
  const position = toNormalized(spec, value);
  const metrics = knobMetrics(size);
  const { center, stroke, radius, bodyRadius } = metrics;
  useAutomationFollow(param, spec, value, bipolar, metrics, arcRef, pointerRef);

  // Automated (or being recorded): a small dot, and the hint says by what.
  const status = useParamStatus(param);
  const name = label ?? spec.label ?? '';
  const valued = `${name}${label || spec.label ? ': ' : ''}${format(value)}`;
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
  const gestures = useKnobGestures({
    spec,
    position,
    disabled,
    hintText: (v) => `${name} ${format(v)}`.trim(),
    onBegin,
    onChange,
    onEnd,
    commit,
  });
  const pointer = pointerEnds(position, metrics);

  return (
    <div
      className={`${styles.knob} ${disabled ? styles.disabled : ''}`}
      style={{ width: size, height: size }}
      role="slider"
      aria-label={label ?? spec.label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={position}
      aria-valuetext={format(value)}
      data-hint={text}
      onPointerDown={gestures.onPointerDown}
      onPointerMove={gestures.onPointerMove}
      onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerUp}
      onDoubleClick={() => !disabled && commit(spec.default)}
      onContextMenu={
        param && openMenu
          ? (e) => {
              e.preventDefault();
              openMenu(param, e);
            }
          : undefined
      }
      onWheel={gestures.onWheel}
    >
      <span className={styles.knobBody} style={{ inset: center - bodyRadius }} aria-hidden />
      <svg className={styles.knobSvg} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <path d={trackPath(metrics)} className={styles.knobTrack} strokeWidth={stroke} />
        {bipolar && <circle cx={center} cy={center - radius} r={stroke * 0.42} className={styles.knobCenter} />}
        <path
          ref={arcRef}
          d={valueArcPath(position, metrics, bipolar)}
          className={styles.knobArc}
          strokeWidth={stroke}
          style={color ? { stroke: color } : undefined}
        />
        <line
          ref={pointerRef}
          x1={pointer.x1}
          y1={pointer.y1}
          x2={pointer.x2}
          y2={pointer.y2}
          className={styles.knobPointer}
        />
      </svg>
      {status && <i className={styles.statusDot} data-kind={status.kind} aria-hidden />}
    </div>
  );
});
