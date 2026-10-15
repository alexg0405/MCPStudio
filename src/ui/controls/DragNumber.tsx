import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { parseTypedNumber } from './number-text';
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
  /** Reads a typed value (default: a number, decimals and a decimal comma allowed); null rejects it. */
  parse?(text: string): number | null;
  /** The text the field starts with when it turns into a text box (default: the number). */
  editText?(v: number): string;
  onBegin?(): void;
  onChange(v: number): void;
  onEnd?(): void;
  /** One-shot edits (wheel; a typed value when there is no onBegin/onEnd gesture). */
  onCommit(v: number): void;
  className?: string;
  hint?: string;
  /** Hint while typing (default: “Type a value · Enter sets it, Esc cancels”). */
  editHint?: string;
  /** Accessible name of the text box. */
  label?: string;
}

/** How far (px) the pointer may move before a press counts as a drag rather than a click. */
const CLICK_SLOP = 2;

/**
 * A number you drag vertically or scroll (FL's tempo/insert boxes). A click (or double-click) turns
 * it into a text box: Enter or leaving it sets the typed value (one undo step, clamped to min..max),
 * Esc cancels.
 */
export function DragNumber({
  value,
  min,
  max,
  perPixel,
  step,
  format,
  parse = parseTypedNumber,
  editText = (v) => String(Math.round(v * 1000) / 1000),
  onBegin,
  onChange,
  onEnd,
  onCommit,
  className,
  hint,
  editHint = 'Type a value · Enter sets it, Esc cancels',
  label,
}: DragNumberProps) {
  const drag = useRef<{ y: number; v: number; moved: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  // Set by Esc so the blur that follows doesn't commit.
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commitTyped = (text: string) => {
    const parsed = parse(text);
    if (parsed === null) return;
    const v = clamp(parsed);
    if (v === value) return;
    // A typed value is its own undo step: a one-step gesture when there is one (never merged into
    // a burst of wheel edits), else a one-shot commit.
    if (onBegin && onEnd) {
      onBegin();
      onChange(v);
      onEnd();
    } else onCommit(v);
  };

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
      if (Math.abs(dy) < CLICK_SLOP) return;
      d.moved = true;
      onBegin?.();
    }
    onChange(clamp(d.v + dy * perPixel * (e.shiftKey ? 0.1 : 1)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.moved) onEnd?.();
    // A click without a drag: type a value.
    else if (d && e.type === 'pointerup') {
      cancelled.current = false;
      setEditing(true);
    }
  };

  // A press anywhere else leaves the box (and sets the value), even where the press keeps the focus
  // (toolbars and canvases prevent the default focus change).
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const el = input.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) el.blur();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={input}
        className={`${styles.input} ${className ?? ''}`}
        autoFocus
        inputMode="decimal"
        aria-label={label}
        defaultValue={editText(value)}
        data-hint={editHint}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          setEditing(false);
          if (!cancelled.current) commitTyped(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            cancelled.current = true;
            e.currentTarget.blur();
          }
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
      onDoubleClick={() => {
        cancelled.current = false;
        setEditing(true);
      }}
      onWheel={(e) => onCommit(clamp(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 0.1 : 1)))}
      data-hint={hint}
    >
      {format(value)}
    </div>
  );
}
