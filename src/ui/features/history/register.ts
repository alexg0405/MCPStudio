import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { HistoryWindow } from './HistoryWindow';

/** The undo history: every change listed; click one to go back (or forward) to it. */
export function register(services: Services): void {
  registerWindowType({
    type: 'history',
    title: () => 'Undo history',
    component: HistoryWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w - 312), y: 40, w: 300, h: Math.min(460, ws.h - 80) }),
    minSize: { w: 220, h: 160 },
  });
  registerWindowToggle(services, {
    command: 'view.history',
    type: 'history',
    title: 'Undo history',
    hint: 'Every change you made; click one to go back to it',
    chords: ['Alt+H'],
    menuOrder: 60,
  });
  addMenuItems('edit', [sep(25), cmd('view.history', 26)]);
}
