import { createElement } from 'react';
import type { Services } from '@app/services';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { Placeholder } from '../../workspace/Placeholder';

export function register(services: Services): void {
  registerWindowType({
    type: 'piano-roll',
    title: () => 'Piano roll',
    component: () =>
      createElement(Placeholder, {
        icon: 'pianoRoll',
        title: 'Piano roll',
        text: 'Draw and edit notes in milestone M3.',
      }),
    defaultRect: (ws) => ({ x: 70, y: 56, w: Math.max(480, ws.w - 140), h: Math.max(300, ws.h - 112) }),
    minSize: { w: 420, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.pianoRoll',
    type: 'piano-roll',
    title: 'Piano roll',
    hint: 'Show or hide the piano roll',
    chords: ['F7', 'Alt+3'],
    menuOrder: 30,
  });
}
