// What a knob does with the mouse and with fingers: vertical drag and wheel nudges (a finger also has its fine modes).
import { useRef, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { fromNormalized, type ParamSpec, type ParamValue } from '../params';
import { emitHint } from './hint';
import { TouchAssist } from './touch-assist';

/** Pixels of vertical drag for the full range. */
const DRAG_TRAVEL_PX = 200;
/** Shift makes a drag this much finer, and a wheel step this much smaller. */
const FINE_DRAG_SCALE = 0.1;
const FINE_WHEEL_SCALE = 0.25;
/** Wheel step for a float, as a share of the range (enums and ints step by one option or one unit). */
const FLOAT_WHEEL_STEP = 0.02;

/** A drag in progress: where it started and the position it is at, in knob travel 0-1. */
interface Drag {
  /** The pointer that drags (a second finger only makes the drag fine; it never takes it over). */
  pointerId: number;
  startY: number;
  startPosition: number;
  fine: boolean;
  position: number;
}

/** What the knob's gestures need: the param, where the knob is and how to report edits. */
export interface KnobGestureOptions {
  spec: ParamSpec;
  /** The knob's current position, 0-1. */
  position: number;
  disabled?: boolean;
  /** Text for the hint bar while dragging. */
  hintText(value: ParamValue): string;
  onBegin?(): void;
  onChange(value: ParamValue): void;
  onEnd?(): void;
  /** One-shot edit (a wheel step). */
  commit(value: ParamValue): void;
  /** A finger rested on the knob and lifted without dragging (a long press): open its menu there. */
  onLongPress?(at: { clientX: number; clientY: number }): void;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** How far one wheel notch moves a knob of this param, in knob travel. */
function wheelStep(spec: ParamSpec): number {
  if (spec.type === 'enum') return 1 / Math.max(1, spec.options.length - 1);
  if (spec.type === 'int') return 1 / Math.max(1, spec.max - spec.min);
  return FLOAT_WHEEL_STEP;
}

/** The pointer and wheel handlers of a knob. Drag is one undo step (`onBegin` to `onEnd`). */
export function useKnobGestures(o: KnobGestureOptions) {
  const drag = useRef<Drag | null>(null);
  const knobElement = useRef<HTMLDivElement | null>(null);
  // A finger's fine modes (see touch-assist.ts): the knob looks held finely while one is on.
  const assist = useRef<TouchAssist | null>(null);
  assist.current ??= new TouchAssist({
    onFineChange: () => knobElement.current?.toggleAttribute('data-fine', assist.current?.isFine ?? false),
  });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (o.disabled || e.button !== 0) return;
    // A second finger on the knob is the fine mode (the assist hears it), not a new drag.
    if (drag.current && e.pointerType === 'touch' && e.pointerId !== drag.current.pointerId) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    knobElement.current = e.currentTarget;
    assist.current?.start(e);
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startPosition: o.position, fine: e.shiftKey, position: o.position };
    // The held look (brighter body and arc) without a React render.
    e.currentTarget.setAttribute('data-dragging', '');
    o.onBegin?.();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const phase = assist.current?.move(e) ?? 'dragging';
    if (phase === 'resting') return;
    const wantsFine = e.shiftKey || (assist.current?.isFine ?? false);
    // Re-anchor when the drag starts past a finger's dead zone, or when Shift (or a second finger) changes, so the knob doesn't jump.
    if (phase === 'started' || wantsFine !== d.fine) {
      d.startY = e.clientY;
      d.startPosition = d.position;
      d.fine = wantsFine;
    }
    const delta = ((d.startY - e.clientY) / DRAG_TRAVEL_PX) * (d.fine ? FINE_DRAG_SCALE : 1);
    const next = clamp01(d.startPosition + delta);
    if (next === d.position) return;
    d.position = next;
    const value = fromNormalized(o.spec, next);
    o.onChange(value);
    emitHint(e.currentTarget, o.hintText(value));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    e.currentTarget.removeAttribute('data-dragging');
    e.currentTarget.releasePointerCapture(e.pointerId);
    o.onEnd?.();
    const restedAt = assist.current?.end();
    if (restedAt && e.type === 'pointerup') o.onLongPress?.({ clientX: restedAt.x, clientY: restedAt.y });
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (o.disabled) return;
    const step = wheelStep(o.spec);
    const next = clamp01(o.position + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? FINE_WHEEL_SCALE : 1));
    if (next !== o.position) o.commit(fromNormalized(o.spec, next));
  };

  return { onPointerDown, onPointerMove, onPointerUp, onWheel };
}
