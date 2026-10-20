/**
 * Whether the last thing the person did was press a key or use a pointer. The app only moves keyboard focus on its own
 * (into a window that just opened, back after one closed) after a key press: a mouse user's focus stays where they put it,
 * and nothing about the mouse experience changes.
 */
let lastInputWasKeyboard = false;

/** True when the most recent input was the keyboard. */
export function wasKeyboardUsed(): boolean {
  return lastInputWasKeyboard;
}

/** Starts watching key and pointer input; returns how to stop. */
export function installModality(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent): void => {
    // A bare modifier is not an action (holding Shift while clicking must not count as keyboard use).
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    lastInputWasKeyboard = true;
  };
  const onPointer = (): void => {
    lastInputWasKeyboard = false;
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointer, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onPointer, true);
  };
}

/** Pretends the last input was the keyboard or a pointer (tests). */
export function setKeyboardUsed(value: boolean): void {
  lastInputWasKeyboard = value;
}
