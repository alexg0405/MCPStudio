/**
 * Touch on a canvas editor (the playlist's grid, the piano roll's grid...): fingers are translated into the gestures
 * the editors know from a mouse, without changing what a mouse does.
 *
 * - One finger gets the editor's own pointer handlers (draw, move or select, whatever the tool is), as a mouse would.
 * - A second finger drops that drag and the two fingers pan and pinch the view (`handlers.twoFinger`).
 * - A finger that rests opens the context menu (`handlers.longPress`), and drops the drag the press had begun.
 * - Two quick taps become a `dblclick`.
 *
 * It listens while capturing, ahead of the editor's own listeners on the same element, and only for `pointerType`
 * 'touch'; mouse and pen events pass through untouched. The gesture rules live in `recognizer.ts` (pure, unit tested).
 */
import type { CleanupList } from '../timeline/listeners';
import { DEFAULT_TUNING, TouchRecognizer, type GestureTuning, type TwoFingerFrame, type Verdict } from './recognizer';

/** What a surface asks of its editor. */
export interface TouchSurfaceHandlers {
  /** Drops the drag the first finger had started with the current tool (what Esc does): nothing is committed. */
  cancelDrag(): void;
  /** Two fingers moved: pan and zoom the view. The frame is reused, so read it and do not keep it. */
  twoFinger?(frame: TwoFingerFrame): void;
  /** One of the two fingers lifted. */
  twoFingerEnd?(): void;
  /** A finger rested at this client point: open the context menu there. */
  longPress?(clientX: number, clientY: number): void;
}

/** A native `dblclick` or `contextmenu` this soon (ms) after a touch is the browser's own version of a gesture the surface already made. */
const NATIVE_ECHO_MS = 1000;

/** Marks an element as a touch surface: the page-wide touch helpers leave its long presses and taps to it. */
export const TOUCH_SURFACE_ATTR = 'data-touch-surface';

/** A double-click event at a client point (what two quick taps mean), sent to whatever is under the finger. */
export function dispatchDoubleClick(clientX: number, clientY: number, fallback: Element): void {
  const target = document.elementFromPoint(clientX, clientY) ?? fallback;
  target.dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX, clientY, detail: 2, view: window }),
  );
}

/**
 * Makes `element` a touch surface. The listeners are removed with `cleanups`. `touch-action: none` keeps the browser from
 * scrolling or zooming the page under the fingers, so every move reaches the editor.
 */
export function attachTouchSurface(
  element: HTMLElement,
  handlers: TouchSurfaceHandlers,
  cleanups: CleanupList,
  tuning: Readonly<GestureTuning> = DEFAULT_TUNING,
): void {
  element.style.touchAction = 'none';
  element.setAttribute(TOUCH_SURFACE_ATTR, '');
  let timer = 0;
  let lastTouchAt = -Infinity;

  const recognizer = new TouchRecognizer(
    {
      onMultiTouchStart: () => handlers.cancelDrag(),
      onTwoFinger: (frame) => handlers.twoFinger?.(frame),
      onTwoFingerEnd: () => handlers.twoFingerEnd?.(),
      onLongPress: (x, y) => {
        handlers.cancelDrag();
        handlers.longPress?.(x, y);
      },
      // After the second tap's own pointer events, so the order is a mouse's: down, up, down, up, double-click.
      onDoubleTap: (x, y) => window.setTimeout(() => dispatchDoubleClick(x, y, element), 0),
    },
    tuning,
  );

  /** Wakes the recognizer when a resting finger becomes a long press. */
  const armLongPress = (): void => {
    window.clearTimeout(timer);
    const deadline = recognizer.nextDeadline();
    if (deadline === null) return;
    timer = window.setTimeout(() => recognizer.tick(Math.max(performance.now(), deadline)), Math.max(0, deadline - performance.now()));
  };

  // Two fingers are measured once per animation frame, after both have moved (see `TouchRecognizer.flush`).
  let frameRequest = 0;
  const flushFrame = (): void => {
    frameRequest = 0;
    recognizer.flush();
  };
  const apply = (event: PointerEvent, verdict: Verdict): void => {
    if (verdict === 'swallow') {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    armLongPress();
    if (recognizer.needsFlush && frameRequest === 0) frameRequest = requestAnimationFrame(flushFrame);
  };
  const isTouch = (event: PointerEvent): boolean => event.pointerType === 'touch';

  cleanups.listen(
    element,
    'pointerdown',
    (event) => {
      if (!isTouch(event)) return;
      lastTouchAt = event.timeStamp;
      apply(event, recognizer.pointerDown(event.pointerId, event.clientX, event.clientY, event.timeStamp));
    },
    { capture: true },
  );
  cleanups.listen(
    element,
    'pointermove',
    (event) => {
      if (!isTouch(event)) return;
      apply(event, recognizer.pointerMove(event.pointerId, event.clientX, event.clientY, event.timeStamp));
    },
    { capture: true },
  );
  cleanups.listen(
    element,
    'pointerup',
    (event) => {
      if (!isTouch(event)) return;
      lastTouchAt = event.timeStamp;
      apply(event, recognizer.pointerUp(event.pointerId, event.clientX, event.clientY, event.timeStamp));
    },
    { capture: true },
  );
  cleanups.listen(
    element,
    'pointercancel',
    (event) => {
      if (!isTouch(event)) return;
      apply(event, recognizer.pointerCancel(event.pointerId));
    },
    { capture: true },
  );

  // The browser makes its own double-click and context menu out of touches too: the surface already did (or chose not to).
  const dropNativeEcho = (event: Event): void => {
    if (!event.isTrusted || event.timeStamp - lastTouchAt > NATIVE_ECHO_MS) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  cleanups.listen(element, 'dblclick', dropNativeEcho, { capture: true });
  cleanups.listen(element, 'contextmenu', dropNativeEcho, { capture: true });
  cleanups.add(() => {
    window.clearTimeout(timer);
    cancelAnimationFrame(frameRequest);
  });
}
