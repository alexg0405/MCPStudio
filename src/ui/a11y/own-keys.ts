/**
 * Controls that keep their own navigation keys. A focused slider uses the arrows, Home, End, Page Up and Page Down to
 * change its value (and Delete to reset it); a focused list, tab strip or menu uses them to move its selection. The
 * window shortcuts that share those keys (the channel rack's Up and Down select a channel, the piano roll's arrows
 * nudge notes) must stand aside while such a control has the focus, or a keyboard user could never reach them.
 */

/** Controls whose value the keys change. */
const VALUE_CONTROLS = '[role="slider"], [role="spinbutton"], [role="scrollbar"], input[type="range"]';

/** Controls that move a selection with the keys; the target may be one of their items. */
const SELECTION_CONTROLS = '[role="listbox"], [role="tree"], [role="tablist"], [role="radiogroup"], [role="menu"], [role="menubar"], [role="combobox"]';

/** The keys these controls take. */
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** What a number box takes besides the arrows: Enter or F2 to type, and the characters of a number. */
const NUMBER_TYPING = /^(Enter|F2|[0-9.,+-])$/;

/** True when the key goes to the focused control instead of the global shortcut handler. */
export function focusOwnsKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target;
  if (!(target instanceof Element)) return false;
  if (target.matches('[role="spinbutton"]') && NUMBER_TYPING.test(e.key)) return true;
  if (target.matches(VALUE_CONTROLS)) return NAVIGATION_KEYS.has(e.key) || e.key === 'Delete' || e.key === 'Backspace';
  return NAVIGATION_KEYS.has(e.key) && target.closest(SELECTION_CONTROLS) !== null;
}
