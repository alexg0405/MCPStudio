import { createElement } from 'react';
import type { Services } from '@app/services';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { registerWindowType, toggleWindow } from '../../workspace/registry';
import { UndoRedo, WindowButtons } from './WindowButtons';
import { ShortcutsWindow } from './ShortcutsWindow';
import { addBrowserSection } from '../../shell/Browser';
import { PluginsSection, ProjectSection, SoundsSection } from './BrowserSections';
import { applyLayout, LAYOUTS } from '../../workspace/layouts';

export const order = 0;

export function register(services: Services): void {
  registerMenuBar();
  registerEditCommands(services);
  registerViewCommands(services);
  registerHelpCommands(services);
  registerShellSlots();
}

/** The top-level menus; other features add entries to them. */
function registerMenuBar(): void {
  registerMenu({ id: 'file', label: 'File', order: 10 });
  registerMenu({ id: 'edit', label: 'Edit', order: 20 });
  registerMenu({ id: 'add', label: 'Add', order: 30 });
  registerMenu({ id: 'view', label: 'View', order: 50 });
  registerMenu({ id: 'help', label: 'Help', order: 90 });
}

/** Undo and redo: commands, keys and the Edit menu entries. */
function registerEditCommands({ commands, keymap }: Services): void {
  commands.register({
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    hint: 'Undo the last change',
    enabled: (s) => s.history.status().canUndo,
    run: (s) => void s.history.undo(),
  });
  commands.register({
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    hint: 'Redo the last undone change',
    enabled: (s) => s.history.status().canRedo,
    run: (s) => void s.history.redo(),
  });

  keymap.add([
    { chord: 'Mod+Z', command: 'edit.undo', repeat: true },
    { chord: 'Mod+Shift+Z', command: 'edit.redo', repeat: true },
    { chord: 'Mod+Y', command: 'edit.redo', repeat: true },
  ]);

  // File menu items come from the files and export features.
  addMenuItems('edit', [cmd('edit.undo', 10), cmd('edit.redo', 20)]);
}

/** The browser panel and the window layouts: commands, keys and View menu entries. */
function registerViewCommands({ commands, keymap }: Services): void {
  commands.register({
    id: 'view.browser',
    title: 'Browser',
    category: 'View',
    hint: 'Show or hide the browser',
    run: (s) => s.view.getState().setBrowser({ visible: !s.view.getState().browser.visible }),
    checked: (s) => s.view.getState().browser.visible,
  });
  keymap.add([
    { chord: 'Alt+F8', command: 'view.browser' },
    { chord: 'Alt+5', command: 'view.browser' },
  ]);
  addMenuItems('view', [sep(80), cmd('view.browser', 90), sep(100)]);
  let order = 110;
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    commands.register({
      id: `view.layout.${name}`,
      title: `Layout: ${layout.title}`,
      category: 'View',
      hint: `Arrange the windows for ${layout.title.toLowerCase()}`,
      run: (s) => applyLayout(s, name),
    });
    addMenuItems('view', [cmd(`view.layout.${name}`, order++)]);
  }
  keymap.add([
    { chord: 'Alt+Shift+1', command: 'view.layout.arrange' },
    { chord: 'Alt+Shift+2', command: 'view.layout.compose' },
    { chord: 'Alt+Shift+3', command: 'view.layout.mix' },
  ]);
}

/** Keyboard shortcuts window, About, their keys and Help menu entries. */
function registerHelpCommands({ commands, keymap }: Services): void {
  registerWindowType({
    type: 'shortcuts',
    title: () => 'Keyboard shortcuts',
    component: ShortcutsWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 260), y: 40, w: 520, h: Math.min(560, ws.h - 80) }),
    minSize: { w: 320, h: 200 },
  });
  commands.register({
    id: 'help.shortcuts',
    title: 'Keyboard shortcuts',
    category: 'Help',
    hint: 'Every keyboard shortcut, grouped by window',
    run: (s) => toggleWindow(s, 'shortcuts'),
  });
  commands.register({
    id: 'help.about',
    title: 'About AGstudio',
    category: 'Help',
    hint: 'Which version this is',
    run: (s) =>
      s.session.getState().toast('AGstudio 0.1: an FL Studio-style DAW you can extend with your own plugins.'),
  });
  keymap.add([{ chord: 'F1', command: 'help.shortcuts' }]);
  addMenuItems('help', [cmd('help.shortcuts', 10), sep(20), cmd('help.about', 30)]);
}

/** The toolbar buttons and the browser panel sections every project has. */
function registerShellSlots(): void {
  addToolbarSlot({ id: 'window-buttons', area: 'right', order: 10, component: () => createElement(WindowButtons) });
  addToolbarSlot({ id: 'undo-redo', area: 'right', order: 20, component: () => createElement(UndoRedo) });

  addBrowserSection({ id: 'plugins', title: 'Plugins', icon: 'plug', order: 10, component: PluginsSection });
  addBrowserSection({ id: 'sounds', title: 'Sounds', icon: 'wave', order: 20, component: SoundsSection });
  addBrowserSection({ id: 'project', title: 'Project patterns', icon: 'note', order: 5, component: ProjectSection });
}
