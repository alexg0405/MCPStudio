import { createElement } from 'react';
import type { Services } from '@app/services';
import { KEYS_VELOCITIES, type KeysVelocity } from '@app/stores/prefs';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { KeysPanel } from './KeysPanel';

/** The Keys window: a piano and drum pads you play with any number of fingers (see `KeysPanel`). */
export function register(services: Services): void {
  registerWindowType({
    type: 'keys',
    title: () => 'Keys',
    component: () => createElement(KeysPanel),
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 380), y: Math.max(0, ws.h - 300), w: 760, h: 280 }),
    minSize: { w: 360, h: 180 },
  });
  registerWindowToggle(services, {
    command: 'view.keys',
    title: 'Keys (piano and drum pads)',
    type: 'keys',
    hint: 'Play the selected channel with your fingers: a piano and sixteen drum pads, one note per finger',
    chords: ['Alt+8'],
    menuOrder: 47,
  });
  services.commands.register<string>({
    id: 'keys.velocity',
    title: 'Keys velocity',
    category: 'View',
    hint: 'How hard the on-screen Keys play: from where a finger lands, or one fixed level',
    argsHint: KEYS_VELOCITIES.map((v) => `'${v}'`).join(', '),
    palette: false,
    run: (s, choice) => {
      const velocity = KEYS_VELOCITIES.find((v): v is KeysVelocity => v === choice);
      if (!velocity) return s.session.getState().toast(`Keys velocity is one of ${KEYS_VELOCITIES.join(', ')}.`, 'error');
      s.prefs.getState().set({ keysVelocity: velocity });
    },
  });
}
