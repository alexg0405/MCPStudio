import type { Services } from '@app/services';
import { ACCESS_CHOICES, UI_SCALE_MAX, UI_SCALE_MIN, type AccessChoice } from '@app/stores/prefs';
import { announce } from '../../a11y/announce';
import { isHighContrast, isReducedMotion } from '../../a11y/preferences';
import { installModality } from '../../a11y/modality';
import { addMenuItems, cmd, submenu, type MenuItem } from '../../shell/menus';
import { registerWindowType, toggleWindow } from '../../workspace/registry';
import { setWindowHelp } from '../../workspace/window-help';
import { installAnnouncers } from './announcers';
import { installFocusFollow } from './focus-follow';
import { KeyboardHelpWindow } from './KeyboardNavigation';
import { activePaneLabel, cyclePane } from './panes';
import { describeWhereAmI } from './where-am-i';

/** How far the Bigger and Smaller commands move the interface size (percentage points). */
const SCALE_STEP = 10;
/** The sizes the Interface size menu offers (percent). */
const SCALE_MENU_STEPS = [90, 100, 110, 125, 150];

/** A percentage kept inside the range the settings allow. */
function clampScale(percent: number): number {
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(percent)));
}

/**
 * Accessibility: the interface size, contrast, motion and colour-blind settings as commands, the keyboard jumps between
 * the parts of the screen, "where am I", the spoken announcements and the Keyboard navigation help.
 */
export function register(services: Services): void {
  installModality();
  installAnnouncers(services);
  installFocusFollow(services);
  registerLookCommands(services);
  registerNavigationCommands(services);
  registerHelp(services);
  registerMenu(services);
}

/** Sets a setting that can follow the system from a command argument; no argument switches between on and off. */
function chooseAccess(argument: unknown, current: AccessChoice): AccessChoice {
  const named = ACCESS_CHOICES.find((choice) => choice === argument);
  if (named) return named;
  return current === 'on' ? 'off' : 'on';
}

/** Interface size, contrast, motion and colour-blind safe colours. */
function registerLookCommands({ commands }: Services): void {
  commands.register<unknown>({
    id: 'options.uiScale',
    title: 'Interface size',
    category: 'Options',
    hint: `Make the text and controls bigger or smaller, from ${UI_SCALE_MIN} to ${UI_SCALE_MAX} percent`,
    argsHint: `a percentage from ${UI_SCALE_MIN} to ${UI_SCALE_MAX} (100 is normal), or 'bigger', 'smaller' or 'reset'`,
    palette: false,
    run: (s, argument) => {
      const prefs = s.prefs.getState();
      const wanted = typeof argument === 'number' ? argument : Number.parseFloat(String(argument ?? ''));
      let percent = prefs.uiScale;
      if (argument === 'bigger') percent += SCALE_STEP;
      else if (argument === 'smaller') percent -= SCALE_STEP;
      else if (argument === 'reset') percent = 100;
      else if (Number.isFinite(wanted)) percent = wanted;
      else return s.session.getState().toast(`The interface size is a percentage from ${UI_SCALE_MIN} to ${UI_SCALE_MAX}.`, 'error');
      prefs.set({ uiScale: clampScale(percent) });
      announce(`Interface size ${clampScale(percent)} percent`);
    },
  });
  for (const [id, title, argument, hint] of [
    ['options.uiScaleUp', 'Bigger interface', 'bigger', 'Make the text and controls 10 percent bigger (up to 150 percent)'],
    ['options.uiScaleDown', 'Smaller interface', 'smaller', 'Make the text and controls 10 percent smaller (down to 90 percent)'],
    ['options.uiScaleReset', 'Normal interface size', 'reset', 'Back to the normal text and control size'],
  ] as const) {
    commands.register({
      id,
      title,
      category: 'Options',
      hint,
      run: (s) => void s.commands.run('options.uiScale', argument),
    });
  }
  commands.register<unknown>({
    id: 'options.highContrast',
    title: 'High contrast',
    category: 'Options',
    hint: 'Stronger text, lines and focus rings on any theme. Auto follows the system’s “increase contrast” setting',
    argsHint: "'on', 'off' or 'auto' (follow the system); leave it out to switch it on or off",
    run: (s, argument) => {
      const choice = chooseAccess(argument, s.prefs.getState().highContrast);
      s.prefs.getState().set({ highContrast: choice });
      announce(`High contrast ${choice}`);
    },
    checked: (s) => isHighContrast() || s.prefs.getState().highContrast === 'on',
  });
  commands.register<unknown>({
    id: 'options.reduceMotion',
    title: 'Less motion',
    category: 'Options',
    hint: 'No gliding or smooth scrolling: the view jumps a page when the playhead reaches the edge. Auto follows the system’s “reduce motion” setting',
    argsHint: "'on', 'off' or 'auto' (follow the system); leave it out to switch it on or off",
    run: (s, argument) => {
      const choice = chooseAccess(argument, s.prefs.getState().reduceMotion);
      s.prefs.getState().set({ reduceMotion: choice });
      announce(`Less motion ${choice}`);
    },
    checked: (s) => isReducedMotion() || s.prefs.getState().reduceMotion === 'on',
  });
  commands.register({
    id: 'options.colorSafe',
    title: 'Colour-blind safe colours',
    category: 'Options',
    hint: 'Blue and orange instead of green and red for meters, notes and lights; clips and lanes also get patterns and shapes',
    run: (s) => {
      const isOn = !s.prefs.getState().colorSafe;
      s.prefs.getState().set({ colorSafe: isOn });
      announce(`Colour-blind safe colours ${isOn ? 'on' : 'off'}`);
    },
    checked: (s) => s.prefs.getState().colorSafe,
  });
}

/** Jumping between the parts of the screen, and "where am I". */
function registerNavigationCommands({ commands, keymap }: Services): void {
  commands.register({
    id: 'view.nextPane',
    title: 'Next window or panel',
    category: 'View',
    hint: 'Move the keyboard to the next part of the screen: menu bar, transport, browser, then each open window',
    ai: false,
    run: (s) => cyclePane(s, 1),
  });
  commands.register({
    id: 'view.prevPane',
    title: 'Previous window or panel',
    category: 'View',
    hint: 'Move the keyboard to the previous part of the screen',
    ai: false,
    run: (s) => cyclePane(s, -1),
  });
  commands.register({
    id: 'a11y.whereAmI',
    title: 'Where am I?',
    category: 'View',
    hint: 'Say which window the keyboard is in, what is selected and whether the song is playing',
    ai: false,
    run: (s) => announce(describeWhereAmI(s, activePaneLabel())),
  });
  keymap.add([
    { chord: 'Ctrl+F6', command: 'view.nextPane' },
    { chord: 'Ctrl+Shift+F6', command: 'view.prevPane' },
    { chord: 'Alt+9', command: 'view.nextPane' },
    { chord: 'Alt+Shift+9', command: 'view.prevPane' },
    { chord: 'Alt+0', command: 'a11y.whereAmI' },
  ]);
}

/** The Keyboard navigation window and its Help menu entry. */
function registerHelp({ commands }: Services): void {
  registerWindowType({
    type: 'keyboard-help',
    title: () => 'Keyboard navigation',
    component: KeyboardHelpWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 280), y: 40, w: 560, h: Math.min(620, ws.h - 80) }),
    minSize: { w: 340, h: 220 },
  });
  commands.register({
    id: 'help.keyboard',
    title: 'Keyboard navigation',
    category: 'Help',
    hint: 'Use AGstudio without a mouse or with a screen reader: how to move between windows, controls and the editors’ cursors',
    run: (s) => toggleWindow(s, 'keyboard-help'),
  });
  addMenuItems('help', [cmd('help.keyboard', 11)]);
  setWindowHelp('keyboard-help', {
    intro: 'Every key for using AGstudio without a mouse, and what a screen reader says.',
    moves: [
      ['Ctrl+F6', 'Jump to the next window or panel'],
      ['Alt+0', 'Say where you are'],
      ['Tab', 'Next control; a toolbar or grid is one stop and the arrow keys move inside it'],
    ],
  });
}

/** Options → Accessibility: the settings as a submenu, so they are one click from the menu bar. */
function registerMenu({ prefs }: Services): void {
  const sizes: MenuItem = {
    kind: 'dynamic',
    id: 'ui-scale-steps',
    order: 0,
    entries: () =>
      SCALE_MENU_STEPS.map((percent) => ({
        label: `${percent} percent${percent === 100 ? ' (normal)' : ''}`,
        checked: prefs.getState().uiScale === percent,
        run: () => prefs.getState().set({ uiScale: percent }),
      })),
  };
  addMenuItems('options', [
    submenu('accessibility', 'Accessibility', 0.25, () => [
      submenu('ui-scale', 'Interface size', 0, () => [sizes]),
      cmd('options.highContrast', 1),
      cmd('options.reduceMotion', 2),
      cmd('options.colorSafe', 3),
    ]),
  ]);
}
