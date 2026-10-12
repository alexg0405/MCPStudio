import { createElement } from 'react';
import type { Services } from '@app/services';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { Placeholder } from '../../workspace/Placeholder';

export function register(services: Services): void {
  registerWindowType({
    type: 'playlist',
    title: () => 'Playlist - Arrangement',
    component: () =>
      createElement(Placeholder, {
        icon: 'playlist',
        title: 'Playlist',
        text: 'Arrange patterns and audio clips into a song in milestone M4.',
      }),
    defaultRect: (ws) => ({
      x: Math.round(ws.w * 0.02),
      y: Math.round(ws.h * 0.03),
      w: Math.round(ws.w * 0.96),
      h: Math.round(ws.h * 0.94),
    }),
    minSize: { w: 360, h: 200 },
  });
  registerWindowToggle(services, {
    command: 'view.playlist',
    type: 'playlist',
    title: 'Playlist',
    hint: 'Show or hide the playlist',
    chords: ['F5', 'Alt+1'],
    menuOrder: 10,
  });
}
