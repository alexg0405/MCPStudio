import { createElement } from 'react';
import type { Services } from '@app/services';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { registerWindowType, toggleWindow } from '../../workspace/registry';
import { WindowButtons } from './WindowButtons';
import { ShortcutsWindow } from './ShortcutsWindow';
import { addBrowserSection } from '../../shell/Browser';
import { PluginsPlaceholder, SoundsPlaceholder } from './BrowserPlaceholders';

export const order = 0;

export function register(services: Services): void {
  registerMenu({ id: 'file', label: 'File', order: 10 });
  registerMenu({ id: 'edit', label: 'Edit', order: 20 });
  registerMenu({ id: 'add', label: 'Add', order: 30 });
  registerMenu({ id: 'view', label: 'View', order: 50 });
  registerMenu({ id: 'help', label: 'Help', order: 90 });

  const { commands, keymap } = services;

  // File commands are placeholders until persistence lands (M4/M6); features re-register them.
  const later = (id: string, title: string, milestone: string) =>
    commands.register({ id, title, hint: `${title} (arrives in ${milestone})`, enabled: () => false, run: () => {} });
  later('file.new', 'New project', 'M4');
  later('file.open', 'Open…', 'M4');
  later('file.save', 'Save', 'M4');
  later('file.saveAs', 'Save as…', 'M4');
  later('file.exportWav', 'Export WAV…', 'M6');
  later('edit.undo', 'Undo', 'M1');
  later('edit.redo', 'Redo', 'M1');

  keymap.add([
    { chord: 'Mod+N', command: 'file.new' },
    { chord: 'Mod+O', command: 'file.open' },
    { chord: 'Mod+S', command: 'file.save', when: { allowInInput: true } },
    { chord: 'Mod+Shift+S', command: 'file.saveAs', when: { allowInInput: true } },
    { chord: 'Mod+R', command: 'file.exportWav' },
    { chord: 'Mod+Z', command: 'edit.undo' },
    { chord: 'Mod+Shift+Z', command: 'edit.redo' },
    { chord: 'Mod+Y', command: 'edit.redo' },
  ]);

  addMenuItems('file', [
    cmd('file.new', 10),
    cmd('file.open', 20),
    sep(30),
    cmd('file.save', 40),
    cmd('file.saveAs', 50),
    sep(60),
    cmd('file.exportWav', 70),
  ]);
  addMenuItems('edit', [cmd('edit.undo', 10), cmd('edit.redo', 20)]);

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
  addMenuItems('view', [sep(80), cmd('view.browser', 90)]);

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
    run: (s) => toggleWindow(s, 'shortcuts'),
  });
  commands.register({
    id: 'help.about',
    title: 'About AGstudio',
    category: 'Help',
    run: (s) =>
      s.session.getState().toast('AGstudio 0.1: an FL Studio-style DAW you can extend with your own plugins.'),
  });
  keymap.add([{ chord: 'F1', command: 'help.shortcuts' }]);
  addMenuItems('help', [cmd('help.shortcuts', 10), sep(20), cmd('help.about', 30)]);

  addToolbarSlot({ id: 'window-buttons', area: 'right', order: 10, component: () => createElement(WindowButtons) });

  // Placeholders; the real sections replace these (same ids) in later milestones.
  addBrowserSection({ id: 'plugins', title: 'Plugins', icon: 'plug', order: 10, component: PluginsPlaceholder });
  addBrowserSection({ id: 'sounds', title: 'Sounds', icon: 'wave', order: 20, component: SoundsPlaceholder });
}
