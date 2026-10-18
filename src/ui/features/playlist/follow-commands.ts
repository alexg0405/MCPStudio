/** The "Follow playhead" commands: they are shared by the playlist and the piano roll, and live in the View menu. */
import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';

/** Registers follow playhead (on or off) and smooth follow (scroll with the song, or turn pages), with their menu entries. */
export function registerFollowCommands(services: Services): void {
  const { commands } = services;
  commands.register<boolean | undefined>({
    id: 'view.followPlayhead',
    title: 'Follow playhead',
    category: 'View',
    hint: 'While playing, the playlist and piano roll scroll along so the playhead stays in view (scrolling by hand pauses it until the playhead is back on screen)',
    argsHint: 'true to turn it on, false to turn it off (leave out to switch it)',
    checked: (s) => s.prefs.getState().followPlayhead,
    run: (s, on) =>
      s.prefs.getState().set({ followPlayhead: typeof on === 'boolean' ? on : !s.prefs.getState().followPlayhead }),
  });
  commands.register<boolean | undefined>({
    id: 'view.followSmooth',
    title: 'Smooth follow (scroll with the song)',
    category: 'View',
    hint: 'On: while following, the view scrolls along with the song and the playhead stays near the middle-left. Off: it turns a page when the playhead reaches the right edge',
    argsHint: 'true for smooth scrolling, false for page turns (leave out to switch it)',
    checked: (s) => s.prefs.getState().followStyle === 'smooth',
    run: (s, on) => {
      const smooth = typeof on === 'boolean' ? on : s.prefs.getState().followStyle !== 'smooth';
      s.prefs.getState().set({ followStyle: smooth ? 'smooth' : 'page' });
    },
  });
  addMenuItems('view', [cmd('view.followPlayhead', 58), cmd('view.followSmooth', 59)]);
  addMenuItems('playlist', [cmd('view.followPlayhead', 1), sep(2)]);
}
