import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import styles from './DragNumber.module.css';

export interface DragNumberProps {
  value: number;
  min: number;
  max: number;
  /** Value change per pixel of vertical drag (Shift divides by 10). */
  perPixel: number;
  /** Wheel / arrow step. */
  step: number;
  format(v: number): string;
  parse?(text: string): number | null;
  onBegin?(): void;
  onChange(v: number): void;
  onEnd?(): void;
  /** One-shot edits (wheel, typed value). */
  onCommit(v: number): void;
  className?: string;
  hint?: string;
}

/** A number you drag vertically (FL's tempo/insert boxes). Double-click to type a value. */
export function DragNumber({
  value,
  min,
  max,
  perPixel,
  step,
  format,
  parse = (t) => (Number.isFinite(Number(t)) ? Number(t) : null),
  onBegin,
  onChange,
  onEnd,
  onCommit,
  className,
  hint,
}: DragNumberProps) {
  const drag = useRef<{ y: number; v: number; moved: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: value, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (!d.moved) {
      if (Math.abs(dy) < 2) return;
      d.moved = true;
      onBegin?.();
    }
    onChange(clamp(d.v + dy * perPixel * (e.shiftKey ? 0.1 : 1)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.moved) onEnd?.();
  };

  if (editing) {
    return (
      <input
        className={`${styles.input} ${className ?? ''}`}
        autoFocus
        defaultValue={String(Math.round(value * 1000) / 1000)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          setEditing(false);
          const v = parse(e.currentTarget.value);
          if (v !== null) onCommit(clamp(v));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = String(value);
            setEditing(false);
          }
          e.stopPropagation();
        }}
      />
    );
  }

  return (
    <div
      className={`${styles.number} ${className ?? ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setEditing(true)}
      onWheel={(e) => onCommit(clamp(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 0.1 : 1)))}
      data-hint={hint}
    >
      {format(value)}
    </div>
  );
}
