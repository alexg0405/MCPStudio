import { createElement } from 'react';
import type { Services } from '@app/services';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { Placeholder } from '../../workspace/Placeholder';

export function register(services: Services): void {
  registerWindowType({
    type: 'mixer',
    title: () => 'Mixer - Master',
    component: () =>
      createElement(Placeholder, {
        icon: 'mixer',
        title: 'Mixer',
        text: 'Insert tracks, meters and effect slots arrive in milestone M5.',
      }),
    defaultRect: (ws) => ({
      x: 36,
      y: Math.round(ws.h * 0.4),
      w: Math.max(480, ws.w - 72),
      h: Math.max(260, Math.round(ws.h * 0.56)),
    }),
    minSize: { w: 420, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.mixer',
    type: 'mixer',
    title: 'Mixer',
    hint: 'Show or hide the mixer',
    chords: ['F9', 'Alt+4'],
    menuOrder: 40,
  });
}
