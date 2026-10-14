import type { Services } from '@app/services';
import { describeTidy, tidyNow, tidyPreview } from '@app/actions/tidy';
import { showDialog } from '../../controls/Dialog';
import { addMenuItems, cmd } from '../../shell/menus';

/**
 * "Clean up the song…" (Playlist menu): removes parts stacked on themselves (they play two or three
 * times as loud), merges automation channels that are the same curve, names one-thing tracks. It
 * says what it will do first; one undo step.
 */
export function register(services: Services): void {
  services.commands.register<{ ask?: boolean } | undefined>({
    id: 'playlist.tidy',
    title: 'Clean up the song…',
    category: 'Playlist',
    hint: 'Remove clips stacked on themselves (they play too loud), merge repeated automation and name tracks after what they play',
    argsHint: 'optional { ask: false } to skip the confirmation',
    run: async (s, args) => {
      const plan = tidyPreview(s);
      if (plan.length === 0) {
        s.session.getState().toast('The song has nothing to clean up.');
        return;
      }
      if (args?.ask !== false) {
        const choice = await showDialog({
          title: 'Clean up the song?',
          message: plan.join('\n'),
          detail: 'Nothing that plays differently is lost, and Undo brings it all back.',
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'tidy', label: 'Clean up', primary: true },
          ],
          cancelId: 'cancel',
        });
        if (choice !== 'tidy') return;
      }
      s.session.getState().toast(describeTidy(tidyNow(s)));
    },
  });
  addMenuItems('playlist', [cmd('playlist.tidy', 50)]);
}
