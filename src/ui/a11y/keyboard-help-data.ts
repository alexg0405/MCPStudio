/**
 * The keyboard-only and screen-reader moves, as data for the "Keyboard navigation" window (Help menu) and for
 * `docs/shortcuts.md`, like the touch gestures are for fingers. The keys of each canvas editor are listed with the editor
 * (they are handled in its own key code, not through the shortcut keymap, so the Shortcuts window cannot list them).
 * `Mod` is Cmd on a Mac and Ctrl elsewhere; the window and the docs spell it out for the platform.
 */

import { EDITOR_KEYBOARD_GROUPS } from './keyboard-help-editors';

/** One move: the keys and what they do. */
export interface KeyboardMove {
  keys: string;
  what: string;
}

/** The moves that belong together (everywhere, or one window). */
export interface KeyboardGroup {
  where: string;
  moves: KeyboardMove[];
}

/** Keys that work in every window and the shell. */
const EVERYWHERE: KeyboardGroup = {
  where: 'Everywhere',
  moves: [
    { keys: 'Tab / Shift+Tab', what: 'Next or previous control. A toolbar, a menu bar or a grid is one stop: the arrow keys move inside it.' },
    { keys: 'Ctrl+F6 / Ctrl+Shift+F6 (or Alt+9 / Alt+Shift+9)', what: 'Next or previous part of the screen: menu bar, transport, browser, then each open window.' },
    { keys: 'Alt+0', what: 'Say where you are: the window, the selected sound and pattern, and whether it is playing.' },
    { keys: 'Space or Enter', what: 'Press the control the keyboard is on. When it is on a window or the page, Space plays and stops.' },
    { keys: 'Mod+K', what: 'Search every action by name and run it.' },
    { keys: 'F1', what: 'The list of all keyboard shortcuts.' },
    { keys: 'Esc', what: 'Close the open menu, dialog or help panel. On a window’s frame or title bar it closes the window.' },
  ],
};

/** Keys in menus, lists and grids. */
const MENUS_AND_LISTS: KeyboardGroup = {
  where: 'Menus, lists and grids',
  moves: [
    { keys: '← → (↑ ↓ in a list)', what: 'Move between the controls of a toolbar, tab strip or list.' },
    { keys: '↑ ↓ ← →', what: 'Move between the squares of the channel rack steps and the clip launcher pads.' },
    { keys: 'Home / End', what: 'First or last control in the group (the start or end of a row in a grid).' },
    { keys: '↓ or Enter on a menu name', what: 'Open the menu; ↑ ↓ choose an entry, → opens a submenu, ← closes it, Esc closes the menu.' },
  ],
};

/** Knobs, faders and number boxes. */
const CONTROLS: KeyboardGroup = {
  where: 'Knobs, faders and number boxes',
  moves: [
    { keys: '← → or ↑ ↓', what: 'Change the value a little; Shift makes it finer.' },
    { keys: 'Page Up / Page Down', what: 'Change the value a lot.' },
    { keys: 'Home / End', what: 'Smallest or largest value.' },
    { keys: 'Enter, then type', what: 'In a number box: type the exact value, Enter keeps it, Esc leaves it as it was.' },
  ],
};

/**
 * Every group, in the order the window and the docs show them. Kept here so the window, the docs and a test read one
 * list; the editors' groups come from `keyboard-help-editors.ts`.
 */
export const KEYBOARD_NAVIGATION: readonly KeyboardGroup[] = [EVERYWHERE, MENUS_AND_LISTS, CONTROLS, ...EDITOR_KEYBOARD_GROUPS];

/** Writes the keys for the platform: `Mod` is Cmd on a Mac and Ctrl elsewhere (the text uses the names the Shortcuts window uses). */
export function spellOutKeys(keys: string, platform: 'mac' | 'other'): string {
  return keys.replace(/\bMod\b/g, platform === 'mac' ? 'Cmd' : 'Ctrl');
}

/** What a screen reader hears, in plain words (the window shows it under the keys). */
export const SCREEN_READER_NOTES: readonly string[] = [
  'Every window is a dialog with its title as its name; every button, knob and fader has a name, and knobs and faders say their value with its unit.',
  'Playing, stopping, recording, finished renders, errors and the Studio’s replies are spoken as they happen.',
  'The keyboard cursor of the editors says what is under it: the track and bar, the clip or note, its length and whether it is selected.',
  'Options → Accessibility has bigger text, high contrast, less motion and colour-blind safe colours.',
];
