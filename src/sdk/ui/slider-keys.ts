// What the keyboard does on a slider-like control (knob, fader, number): one function, so every control answers the same keys.

/** How far each kind of key moves a control, in the control's own travel (0-1 for a knob). */
export interface SliderSteps {
  /** An arrow key. */
  step: number;
  /** An arrow key with Shift held (a finer nudge). */
  fineStep: number;
  /** Page Up and Page Down. */
  bigStep: number;
}

/** The steps a float control moves by: 1 % of its travel per arrow, 0.1 % with Shift, 10 % per page. */
export const FLOAT_STEPS: SliderSteps = { step: 0.01, fineStep: 0.001, bigStep: 0.1 };

/** Steps for a control with `count` distinct positions (an enum's options, an int's units): one position per arrow. */
export function discreteSteps(count: number): SliderSteps {
  const one = 1 / Math.max(1, count - 1);
  return { step: one, fineStep: one, bigStep: Math.max(one, Math.round(count / 10) * one) };
}

/** True for the keys a slider uses for moving (arrows, Home, End, Page Up, Page Down). */
export function isSliderMoveKey(key: string): boolean {
  return key.startsWith('Arrow') || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
}

/** True for the keys that put a slider back to its default value. */
export function isSliderResetKey(key: string): boolean {
  return key === 'Delete' || key === 'Backspace';
}

/**
 * Where a key press moves a slider that is at `position` (0-1): Up and Right raise, Down and Left lower, Shift is fine,
 * Page Up and Page Down jump, Home and End go to the ends. Null when the key does not move it (or a modifier other
 * than Shift is held, which belongs to a shortcut).
 */
export function sliderKeyTarget(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  position: number,
  steps: SliderSteps,
): number | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const step = e.shiftKey ? steps.fineStep : steps.step;
  let next: number;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = position + step;
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = position - step;
  else if (e.key === 'PageUp') next = position + steps.bigStep;
  else if (e.key === 'PageDown') next = position - steps.bigStep;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = 1;
  else return null;
  return Math.min(1, Math.max(0, next));
}
