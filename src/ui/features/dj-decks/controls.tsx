import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { emitHint } from '@agstudio/sdk/ui';
import type { DeckId } from '@app/dj/decks-api';
import { isTargetId } from '@core/midi-map/targets';
import styles from './DjDecks.module.css';

/**
 * The MIDI-learn id of one of a deck's controls ("A.play", "B.hotcue:3"). Undefined when the catalog
 * (`core/midi-map/targets.ts`) has no such target, so a control without one simply is not tagged.
 */
export function deckTarget(deck: DeckId, fn: string): string | undefined {
  const id = `${deck}.${fn}`;
  return isTargetId(id) ? id : undefined;
}

/**
 * Tags a control that cannot take `data-dj-target` itself (the shared Knob) for MIDI learn. The wrapper
 * has `display: contents`, so it takes no room and the layout stays the same.
 */
export function MidiTarget({ id, children }: { id: string | undefined; children: ReactNode }) {
  return (
    <div style={{ display: 'contents' }} data-dj-target={id}>
      {children}
    </div>
  );
}

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  /** Where the double-click puts it back (and where a mark is drawn). */
  reset: number;
  vertical?: boolean;
  /** Accessible name and hint ("Deck A volume"). */
  label: string;
  /** What it does, in plain words (after the value in the hint bar). */
  hint: string;
  format(v: number): string;
  onChange(v: number): void;
  /** Marks along the track (values), e.g. unity. */
  marks?: readonly number[];
  className?: string;
  /** The MIDI-learn target id this slider is ("A.pitch"). */
  target?: string;
}

/**
 * A slim slider with a machined cap: a vertical channel or pitch fader, or the horizontal crossfader. Drag it
 * (Shift for fine steps), scroll over it, or double-click to put it back. Controlled: the decks own the value.
 */
export function Slider({ value, min, max, reset, vertical, label, hint, format, onChange, marks, className, target }: SliderProps) {
  const drag = useRef<{ at: number; from: number; fine: boolean; start: number; extent: number } | null>(null);
  const frac = (v: number) => (v - min) / (max - min);
  const set = (f: number) => onChange(min + Math.min(1, Math.max(0, f)) * (max - min));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    const extent = Math.max(20, vertical ? r.height : r.width);
    const pos = vertical ? e.clientY : e.clientX;
    // Pressing on the track jumps the cap there; pressing on the cap holds it where it is.
    const rel = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    const onCap = Math.abs(rel - frac(value)) < 14 / extent;
    const from = onCap ? frac(value) : Math.min(1, Math.max(0, rel));
    if (!onCap) set(from);
    drag.current = { at: from, from, fine: e.shiftKey, start: pos, extent };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const pos = vertical ? e.clientY : e.clientX;
    if (e.shiftKey !== d.fine) {
      d.start = pos;
      d.from = d.at;
      d.fine = e.shiftKey;
    }
    const delta = ((vertical ? d.start - pos : pos - d.start) / d.extent) * (d.fine ? 0.1 : 1);
    const next = Math.min(1, Math.max(0, d.from + delta));
    if (next === d.at) return;
    d.at = next;
    set(next);
    emitHint(e.currentTarget, `${label}: ${format(min + next * (max - min))}`);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const step = 0.02 * (e.shiftKey ? 0.25 : 1) * (e.deltaY < 0 ? 1 : -1);
    set(frac(value) + step);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    const dir = k === 'ArrowUp' || k === 'ArrowRight' ? 1 : k === 'ArrowDown' || k === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    set(frac(value) + dir * (e.shiftKey ? 0.005 : 0.02));
  };

  const f = frac(value);
  const cap = vertical ? { bottom: `calc(${f * 100}% - 7px)` } : { left: `calc(${f * 100}% - 7px)` };
  return (
    <div
      className={`${vertical ? styles.vslider : styles.hslider} ${className ?? ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={format(value)}
      data-dj-target={target}
      data-hint={`${label}: ${format(value)}. ${hint} Drag (Shift = fine), scroll, or double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(reset)}
    >
      <div className={styles.track} />
      {(marks ?? [reset]).map((m) => (
        <i key={m} className={styles.mark} style={vertical ? { bottom: `${frac(m) * 100}%` } : { left: `${frac(m) * 100}%` }} />
      ))}
      <div className={styles.cap} style={cap} />
    </div>
  );
}

/** A small button that lights when on (key lock, sync, cue listen…). Always has a hint. */
export function PadButton({
  on,
  label,
  hint,
  onClick,
  onPointerDown,
  onPointerUp,
  onContextMenu,
  disabled,
  className,
  children,
  style,
  target,
}: {
  on?: boolean;
  label: string;
  hint: string;
  onClick?(): void;
  onPointerDown?(e: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerUp?(e: ReactPointerEvent<HTMLButtonElement>): void;
  onContextMenu?(e: React.MouseEvent): void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  style?: React.CSSProperties;
  /** The MIDI-learn target id this pad is ("A.play"). */
  target?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`${styles.pad} ${on ? styles.padOn : ''} ${className ?? ''}`}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      data-dj-target={target}
      data-hint={hint}
      disabled={disabled}
      style={style}
      onPointerDown={(e) => {
        // Keep the keyboard focus on the window, so its shortcuts keep working after a click.
        e.preventDefault();
        onPointerDown?.(e);
      }}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </button>
  );
}
