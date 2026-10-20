import type { KeyboardGroup } from './keyboard-help-data';

/**
 * The keys of the three canvas editors' keyboard cursors (playlist, piano roll, pitch editor). They are handled by the
 * editors' own key code, so they are listed here by hand; the browser tests of each editor send these keys.
 */
export const EDITOR_KEYBOARD_GROUPS: readonly KeyboardGroup[] = [];
