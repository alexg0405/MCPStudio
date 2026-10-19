import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { TouchAssist } from '@agstudio/sdk/ui';
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

/**
 * The text box a DragNumber turns into when clicked: Enter or leaving it hands back the typed text, Esc hands back null
 * (cancel). A press anywhere else leaves the box too, even where the press keeps the focus (toolbars and canvases prevent
 * the default focus change).
 */
function TypedNumberInput({ className, label, text, hint, onFinish }: { className?: string | undefined; label?: string | undefined; text: string; hint: string; onFinish(typed: string | null): void }) {
  // Set by Esc so the blur that follows doesn't commit.
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = input.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) el.blur();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);
  return (
    <input
      ref={input}
      className={`${styles.input} ${className ?? ''}`}
      autoFocus
      inputMode="decimal"
      aria-label={label}
      defaultValue={text}
      data-hint={hint}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => onFinish(cancelled.current ? null : e.currentTarget.value)}
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
  const drag = useRef<{ pointerId: number; y: number; v: number; moved: boolean; fine: boolean } | null>(null);
  // A finger's dead zone and fine modes (a second finger, or a first rest), as on the knobs.
  const assist = useRef<TouchAssist | null>(null);
  assist.current ??= new TouchAssist({ onFineChange: () => {} });
  const [editing, setEditing] = useState(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  /** The value the drag last set, so a re-anchor continues from it. */
  const currentValue = useRef(value);

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
    // A second finger on the number is the fine mode (the assist hears it), not a new drag.
    if (drag.current && e.pointerType === 'touch' && e.pointerId !== drag.current.pointerId) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    assist.current?.start(e);
    drag.current = { pointerId: e.pointerId, y: e.clientY, v: value, moved: false, fine: e.shiftKey };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const phase = assist.current?.move(e) ?? 'dragging';
    if (phase === 'resting') return;
    const wantsFine = e.shiftKey || (assist.current?.isFine ?? false);
    // A finger's drag starts where it leaves the dead zone; Shift (or a second finger) re-anchors so the number doesn't jump.
    if (phase === 'started' || wantsFine !== d.fine) {
      d.y = e.clientY;
      d.v = d.moved ? currentValue.current : value;
      d.fine = wantsFine;
    }
    const dy = d.y - e.clientY;
    if (!d.moved) {
      if (phase !== 'started' && Math.abs(dy) < CLICK_SLOP) return;
      d.moved = true;
      onBegin?.();
    }
    currentValue.current = clamp(d.v + dy * perPixel * (d.fine ? 0.1 : 1));
    onChange(currentValue.current);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && e.pointerId !== d.pointerId) return;
    drag.current = null;
    assist.current?.end();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.moved) onEnd?.();
    // A click without a drag: type a value.
    else if (d && e.type === 'pointerup') setEditing(true);
  };

  if (editing) {
    return (
      <TypedNumberInput
        className={className}
        label={label}
        text={editText(value)}
        hint={editHint}
        onFinish={(text) => {
          setEditing(false);
          if (text !== null) commitTyped(text);
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
      data-touch-own=""
      onDoubleClick={() => setEditing(true)}
      onWheel={(e) => onCommit(clamp(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 0.1 : 1)))}
      data-hint={hint}
    >
      {format(value)}
    </div>
  );
}
