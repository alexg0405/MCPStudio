/**
 * The touch layout: bigger buttons, handles and step squares so a finger can hit them. It is a setting with three
 * choices (`prefs.touchLayout`): 'auto' follows the device (on when its main pointer is coarse, like a tablet's;
 * a laptop with a touchscreen keeps its trackpad as the main pointer, so it stays off until chosen), 'on' and 'off'.
 *
 * The result is one attribute on the page, `<html data-touch="on" | "off">`; the sizes themselves are in `touch.css`.
 */
import type { PrefsStore, TouchLayoutChoice } from '@app/stores/prefs';

/** The media query that says the main pointer is a finger (or another coarse pointer). */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** Whether the touch layout is on for a setting, given whether the device's main pointer is coarse. */
export function resolveTouchLayout(choice: TouchLayoutChoice, hasCoarsePointer: boolean): boolean {
  if (choice === 'auto') return hasCoarsePointer;
  return choice === 'on';
}

const listeners = new Set<() => void>();

/** True while the touch layout is on (read from the page's attribute, so it is right from the first render). */
export function isTouchLayout(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.touch === 'on';
}

/** Calls `listener` whenever the touch layout turns on or off; returns how to stop. */
export function subscribeTouchLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keeps `<html data-touch>` in step with the setting and the device. Call once at startup; the returned function stops it.
 * `matches` lets tests pretend to be a tablet.
 */
export function installTouchLayout(prefs: PrefsStore, matches: () => boolean = () => matchMedia(COARSE_POINTER_QUERY).matches): () => void {
  const root = document.documentElement;
  const apply = (): void => {
    const next = resolveTouchLayout(prefs.getState().touchLayout, matches()) ? 'on' : 'off';
    if (root.dataset.touch === next) return;
    root.dataset.touch = next;
    for (const listener of [...listeners]) listener();
  };
  apply();
  const query = typeof matchMedia === 'function' ? matchMedia(COARSE_POINTER_QUERY) : null;
  query?.addEventListener('change', apply);
  const unsubscribe = prefs.subscribe(apply);
  return () => {
    query?.removeEventListener('change', apply);
    unsubscribe();
  };
}
