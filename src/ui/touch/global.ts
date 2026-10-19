/**
 * Touch help for everything that is not a canvas editor (those are `touch surface`s and do their own): on any button,
 * label, row or control,
 *
 * - a finger that rests (about half a second) is a right-click: the element gets a `contextmenu` event there; when nothing
 *   opens a menu, the element's hint is shown instead (a touchscreen has no hover for tooltips);
 * - two quick taps are a double-click: the element gets a `dblclick` event (knobs reset, window titles maximize...).
 *
 * Controls that handle a resting finger themselves (knobs, faders, the platter) carry `data-touch-own`; surfaces carry
 * `data-touch-surface`. Text fields keep the browser's own touch behaviour. Mouse and pen events are not touched.
 */
import { TouchRecognizer } from './recognizer';
import { dispatchDoubleClick, TOUCH_SURFACE_ATTR } from './surface';
import { TOUCH_HINT_EVENT } from './events';

/** The attribute of a control that handles its own long press (the page-wide long press leaves it alone). */
export const TOUCH_OWN_ATTR = 'data-touch-own';

/** A native `dblclick` or `contextmenu` this soon (ms) after a touch is the browser's echo of what these helpers already did. */
const NATIVE_ECHO_MS = 1000;
/** A hint shown by a long press goes away by itself after this long (ms). */
export const TOUCH_HINT_MS = 3500;

/** Text fields keep the browser's touch behaviour (caret, selection, paste menu). */
function isEditable(element: Element): boolean {
  return element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

/** True for a touch that belongs to a surface or a text field: the helpers ignore it from start to finish. */
function isLeftToOthers(element: Element): boolean {
  return element.closest(`[${TOUCH_SURFACE_ATTR}]`) !== null || isEditable(element);
}

/** A click this soon (ms) after a resting finger lifted is the rest's own tail, not a press: it does nothing. */
const CLICK_AFTER_REST_MS = 600;

/** The right-click of a resting finger: a `contextmenu` event, or the hint when nobody opened a menu. Returns false when it left the touch alone. */
function restOn(target: Element, clientX: number, clientY: number): boolean {
  if (!target.isConnected || target.closest(`[${TOUCH_OWN_ATTR}]`)) return false;
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 2,
    view: window,
  });
  const isUnhandled = target.dispatchEvent(event);
  if (isUnhandled) target.dispatchEvent(new CustomEvent(TOUCH_HINT_EVENT, { bubbles: true }));
  return true;
}

/** Installs the page-wide touch help. Returns how to remove it. */
export function installTouchHelpers(): () => void {
  /** Pointers a surface or a text field owns, and what each finger first touched. */
  const ignored = new Set<number>();
  const targets = new Map<number, Element>();
  let lastTouchAt = -Infinity;
  /** The finger whose rest did something: its lift must not also press the button it rests on. */
  let restingPointer = -1;
  let swallowClicksUntil = -Infinity;

  const recognizer = new TouchRecognizer({
    onLongPress: (x, y, pointerId) => {
      const target = targets.get(pointerId);
      if (target && restOn(target, x, y)) restingPointer = pointerId;
    },
    onDoubleTap: (x, y) => window.setTimeout(() => dispatchDoubleClick(x, y, document.body), 0),
  });
  let timer = 0;
  const arm = (): void => {
    window.clearTimeout(timer);
    const deadline = recognizer.nextDeadline();
    if (deadline === null) return;
    timer = window.setTimeout(() => recognizer.tick(Math.max(performance.now(), deadline)), Math.max(0, deadline - performance.now()));
  };

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    lastTouchAt = event.timeStamp;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || isLeftToOthers(target)) {
      ignored.add(event.pointerId);
      return;
    }
    targets.set(event.pointerId, target);
    recognizer.pointerDown(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    arm();
  };
  const onMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || ignored.has(event.pointerId)) return;
    recognizer.pointerMove(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    arm();
  };
  const onEnd = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    lastTouchAt = event.timeStamp;
    if (ignored.delete(event.pointerId)) return;
    targets.delete(event.pointerId);
    if (event.pointerId === restingPointer) {
      restingPointer = -1;
      swallowClicksUntil = event.timeStamp + CLICK_AFTER_REST_MS;
    }
    if (event.type === 'pointerup') recognizer.pointerUp(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    else recognizer.pointerCancel(event.pointerId);
    arm();
  };
  const dropNativeEcho = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!event.isTrusted || event.timeStamp - lastTouchAt > NATIVE_ECHO_MS || (target && isEditable(target))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onEnd, true);
  document.addEventListener('pointercancel', onEnd, true);
  const dropClickAfterRest = (event: Event): void => {
    if (!event.isTrusted || event.timeStamp > swallowClicksUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('dblclick', dropNativeEcho, true);
  document.addEventListener('contextmenu', dropNativeEcho, true);
  document.addEventListener('click', dropClickAfterRest, true);
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onEnd, true);
    document.removeEventListener('pointercancel', onEnd, true);
    document.removeEventListener('dblclick', dropNativeEcho, true);
    document.removeEventListener('contextmenu', dropNativeEcho, true);
    document.removeEventListener('click', dropClickAfterRest, true);
  };
}
