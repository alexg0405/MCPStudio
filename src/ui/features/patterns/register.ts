import { createElement } from 'react';
import type { Services } from '@app/services';
import { cloneCurrentPattern, deletePattern, newPattern, stepPattern } from '@app/actions/patterns';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { PatternPicker } from './PatternPicker';

export const order = 15;

export function register(services: Services): void {
  const { commands, keymap } = services;
  registerMenu({ id: 'patterns', label: 'Patterns', order: 42 });
  commands.register({ id: 'patterns.new', title: 'New pattern', category: 'Patterns', run: (s) => void newPattern(s) });
  commands.register({
    id: 'patterns.clone',
    title: 'Clone pattern',
    category: 'Patterns',
    run: (s) => void cloneCurrentPattern(s),
  });
  commands.register({
    id: 'patterns.delete',
    title: 'Delete pattern',
    category: 'Patterns',
    enabled: (s) => s.doc.getState().project.patternOrder.length > 1,
    run: (s) => {
      const id = s.view.getState().currentPatternId;
      if (id) deletePattern(s, id);
    },
  });
  commands.register({
    id: 'patterns.next',
    title: 'Next pattern',
    category: 'Patterns',
    run: (s) => stepPattern(s, 1),
  });
  commands.register({
    id: 'patterns.prev',
    title: 'Previous pattern',
    category: 'Patterns',
    run: (s) => stepPattern(s, -1),
  });
  keymap.add([
    { chord: 'F4', command: 'patterns.new' },
    { chord: 'NumpadAdd', command: 'patterns.next', repeat: true },
    { chord: 'NumpadSubtract', command: 'patterns.prev', repeat: true },
  ]);
  addMenuItems('patterns', [
    cmd('patterns.new', 10),
    cmd('patterns.clone', 20),
    cmd('patterns.delete', 30),
    sep(40),
    cmd('patterns.next', 50),
    cmd('patterns.prev', 60),
  ]);
  addToolbarSlot({ id: 'pattern-picker', area: 'center', order: 0, component: () => createElement(PatternPicker) });
}
