/**
 * Takes and comping: the commands, menu entries and key bindings that work on a recording's take group (a comp track
 * with its takes folded under it). The playlist's Comp tool (drag across a take) lives in the playlist's pointer code
 * (`playlist/control/comp-swipe.ts`); everything it can do is here too, for menus, the action search and the AI.
 */
import type { Services } from '@app/services';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { registerChooseCommands } from './choose-commands';
import { registerCompCommands } from './comp-commands';
import { registerListenCommand } from './listen-command';
import { takeClipMenu, takeLaneMenu } from './menus';

/** Registers the take commands, their right-click menu entries and their Playlist menu entries. */
export function register(services: Services): void {
  registerChooseCommands(services);
  registerListenCommand(services);
  registerCompCommands(services);
  addContextMenuItems('playlist.clip', ({ clip }, s) => takeClipMenu(s, clip));
  addContextMenuItems('playlist.lane', ({ laneId }, s) => takeLaneMenu(s, laneId));
  addMenuItems('playlist', [
    cmd('comp.useTake', 60),
    cmd('comp.nextTake', 61),
    cmd('comp.previousTake', 62),
    cmd('comp.listenTake', 66),
    cmd('comp.toggleTakes', 63),
    cmd('comp.crossfade', 64),
    cmd('comp.flatten', 65),
    cmd('comp.addTakes', 67),
    sep(69),
  ]);
}
