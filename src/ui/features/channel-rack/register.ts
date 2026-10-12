import { createElement } from 'react';
import type { Services } from '@app/services';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { Placeholder } from '../../workspace/Placeholder';

export function register(services: Services): void {
  registerWindowType({
    type: 'channel-rack',
    title: () => 'Channel rack',
    component: () =>
      createElement(Placeholder, {
        icon: 'channelRack',
        title: 'Channel rack',
        text: 'Channels and the step sequencer arrive in milestone M1.',
      }),
    defaultRect: (ws) => ({ x: 48, y: 36, w: Math.min(720, ws.w - 96), h: 330 }),
    minSize: { w: 420, h: 160 },
  });
  registerWindowToggle(services, {
    command: 'view.channelRack',
    type: 'channel-rack',
    title: 'Channel rack',
    hint: 'Show or hide the channel rack',
    chords: ['F6', 'Alt+2'],
    menuOrder: 20,
  });
}
