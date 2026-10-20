import type { Services } from '@app/services';
import { startKeyRouting } from '../../timeline/key-cursor/router';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { lazyWindow } from '../../workspace/lazy';
import { addPianoRollEditMenu, addPianoRollKeys } from './bindings';
import { registerCompositionCommands } from './composition-commands';
import { registerEditCommands } from './edit-commands';
import { registerToolCommands } from './tool-commands';

/** The piano roll: its window, the Piano roll toggle, and its commands, shortcuts and Edit menu entries. */
export function register(services: Services): void {
  // Before the app's key handler is installed, so the grid's cursor keys reach it first (timeline/key-cursor/router.ts).
  startKeyRouting();
  registerWindowType({
    type: 'piano-roll',
    title: (_props, s) => {
      const id = s.session.getState().selectedChannelId;
      const ch = id ? s.doc.getState().project.channels[id] : undefined;
      return ch ? `Piano roll - ${ch.name}` : 'Piano roll';
    },
    // Loads on first use (and at idle time after the first paint): the controller and drawing code are most of the roll.
    component: lazyWindow(() => import('./PianoRoll'), (m) => m.PianoRoll),
    defaultRect: (ws) => ({ x: 60, y: 46, w: Math.max(520, ws.w - 120), h: Math.max(320, ws.h - 92) }),
    minSize: { w: 420, h: 240 },
  });
  registerWindowToggle(services, {
    command: 'view.pianoRoll',
    type: 'piano-roll',
    title: 'Piano roll',
    hint: 'Show or hide the piano roll for the selected channel',
    chords: ['F7', 'Alt+3'],
    menuOrder: 30,
  });
  registerToolCommands(services);
  registerEditCommands(services);
  registerCompositionCommands(services);
  addPianoRollKeys(services);
  addPianoRollEditMenu(services);
}
