/**
 * Gives a keyboard-focused canvas editor its keys before the app's shortcuts see them.
 *
 * The app has one capture-phase key handler on the window (`ui/keyboard.ts`). It would take the arrow keys, Delete,
 * Escape, Ctrl+A and Alt+arrows for the window's own shortcuts (nudge, transpose, delete, octave of the typing piano)
 * before an editor's own listener ever ran. An editor with a keyboard cursor registers here instead: this module listens
 * on the window too, and because `registerFeatures` runs before `installKeyboard`, it listens first. A key it hands to
 * an editor that handles it is swallowed; every other key goes on to the shortcuts as usual (Space still plays,
 * Ctrl+C still copies, a tool letter still switches the tool).
 *
 * Only a stack that has the focus from the keyboard (Tab, not a mouse click) gets keys, and a click with the mouse or a
 * finger inside it hands them back until the next Tab, so a mouse user's arrow keys keep nudging and transposing the
 * selection as they always did.
 */

/** What an editor gives the router: its element, whether its cursor is in use, and how it handles a key (true when the key was used). */
export interface KeyOwner {
  element: HTMLElement;
  /** True while the cursor is shown and the keys are its (not after a click with the mouse). */
  isActive(): boolean;
  onKeyDown(event: KeyboardEvent): boolean;
}

/** Marks an element as a keyboard-cursor stack (the CSS for the focus frame and the router both look for it). */
export const KEY_CURSOR_ATTRIBUTE = 'data-key-cursor';

const owners = new WeakMap<Element, KeyOwner>();
let isListening = false;

/** True when the element has the focus because of the keyboard (Tab), as the browser's `:focus-visible` says. */
export function hasKeyboardFocus(element: HTMLElement): boolean {
  return document.activeElement === element && element.matches(':focus-visible');
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.hasAttribute(KEY_CURSOR_ATTRIBUTE)) return;
  const owner = owners.get(target);
  if (!owner || event.isComposing || !owner.isActive() || !hasKeyboardFocus(target)) return;
  if (!owner.onKeyDown(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function listenOnce(): void {
  if (isListening || typeof window === 'undefined') return;
  isListening = true;
  window.addEventListener('keydown', onKeyDown, { capture: true });
}

/**
 * Starts routing keys of `owner.element` to the owner. Returns how to stop. `startKeyRouting()` must have run (the
 * features do it when they register); registering an owner also starts it, which only matters in tests.
 */
export function registerKeyOwner(owner: KeyOwner): () => void {
  listenOnce();
  owner.element.setAttribute(KEY_CURSOR_ATTRIBUTE, '');
  owners.set(owner.element, owner);
  return () => {
    owners.delete(owner.element);
    owner.element.removeAttribute(KEY_CURSOR_ATTRIBUTE);
  };
}

/**
 * Starts listening on the window now. Features call this from `register()` so the listener sits before the app's
 * shortcut handler (listeners run in the order they were added). Safe to call again, and a no-op without a window.
 */
export function startKeyRouting(): void {
  listenOnce();
}
