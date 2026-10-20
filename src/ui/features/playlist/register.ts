import type { Services } from '@app/services';
import { startKeyRouting } from '../../timeline/key-cursor/router';
import { registerMenu } from '../../shell/menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { registerPlaylistEditCommands } from './edit-commands';
import { registerFollowCommands } from './follow-commands';
import { Playlist } from './Playlist';

/** The playlist: its window, the Playlist toggle and menu, follow playhead, and its tools and clip editing commands. */
export function register(services: Services): void {
  // Before the app's key handler is installed, so the grid's cursor keys reach it first (timeline/key-cursor/router.ts).
  startKeyRouting();
  // Markers, audio clip edits and recording add their entries to it.
  registerMenu({ id: 'playlist', label: 'Playlist', order: 44 });
  registerWindowType({
    type: 'playlist',
    title: () => 'Playlist - Arrangement',
    component: Playlist,
    defaultRect: (ws) => ({
      x: Math.round(ws.w * 0.02),
      y: Math.round(ws.h * 0.03),
      w: Math.round(ws.w * 0.96),
      h: Math.round(ws.h * 0.94),
    }),
    minSize: { w: 420, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.playlist',
    type: 'playlist',
    title: 'Playlist',
    hint: 'Show or hide the playlist',
    chords: ['F5', 'Alt+1'],
    menuOrder: 10,
  });
  registerFollowCommands(services);
  registerPlaylistEditCommands(services);
}
