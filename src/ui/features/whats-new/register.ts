import type { Services } from '@app/services';
import { addMenuItems, cmd } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { WhatsNewOverlay } from './WhatsNew';
import { openWhatsNew } from './whats-new-state';

/**
 * What's new: a short illustrated list of the newest features, opened once after an update (`main.tsx` asks) and from
 * Help → What's new any time. Each entry's "Show me" opens the window or menu and highlights the control.
 */
export function register(services: Services): void {
  services.commands.register({
    id: 'help.whatsNew',
    title: 'What’s new',
    category: 'Help',
    hint: 'The newest features of AGstudio, each with a button that opens it and points at it',
    run: (s) => openWhatsNew(s),
  });
  addMenuItems('help', [cmd('help.whatsNew', 3.6)]);
  addOverlay('whats-new', WhatsNewOverlay);
}
