import { createElement } from 'react';
import type { Services } from '@app/services';
import { createDefaultProject } from '@app/default-project';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { registerWindowType, toggleWindow } from '../../workspace/registry';
import { UndoRedo, WindowButtons } from './WindowButtons';
import { ShortcutsWindow } from './ShortcutsWindow';
import { addBrowserSection } from '../../shell/Browser';
import { PluginsSection, SoundsSection } from './BrowserSections';
import { applyLayout, LAYOUTS } from '../../workspace/layouts';

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
  commands.register({
    id: 'file.new',
    title: 'New project',
    category: 'File',
    hint: 'Start a new project from the default template',
    run: (s) => {
      if (s.history.status().canUndo && !window.confirm('Start a new project? Unsaved changes will be lost.')) return;
      s.engine.stop();
      s.history.load(createDefaultProject(s.plugins));
      const p = s.doc.getState().project;
      s.view.getState().setCurrentPattern(p.patternOrder[0] ?? null);
      s.session.getState().selectChannel(p.channelOrder[0] ?? null);
    },
  });
  later('file.open', 'Open…', 'M4');
  later('file.save', 'Save', 'M4');
  later('file.saveAs', 'Save as…', 'M4');
  later('file.exportWav', 'Export WAV…', 'M6');
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
    { chord: 'Mod+N', command: 'file.new' },
    { chord: 'Mod+O', command: 'file.open' },
    { chord: 'Mod+S', command: 'file.save', when: { allowInInput: true } },
    { chord: 'Mod+Shift+S', command: 'file.saveAs', when: { allowInInput: true } },
    { chord: 'Mod+R', command: 'file.exportWav' },
    { chord: 'Mod+Z', command: 'edit.undo', repeat: true },
    { chord: 'Mod+Shift+Z', command: 'edit.redo', repeat: true },
    { chord: 'Mod+Y', command: 'edit.redo', repeat: true },
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
  addToolbarSlot({ id: 'undo-redo', area: 'right', order: 20, component: () => createElement(UndoRedo) });

  addBrowserSection({ id: 'plugins', title: 'Plugins', icon: 'plug', order: 10, component: PluginsSection });
  addBrowserSection({ id: 'sounds', title: 'Sounds', icon: 'wave', order: 20, component: SoundsSection });
}
