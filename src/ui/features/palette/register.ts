import type { Services } from '@app/services';
import { addMenuItems, cmd } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { PaletteOverlay, togglePalette } from './Palette';

/** The action search: type what you want to do, and run it (or ask the AI to). */
export function register(services: Services): void {
  services.commands.register({
    id: 'help.palette',
    title: 'Search actions…',
    category: 'Help',
    hint: 'Find any action by typing what you want to do; if nothing fits, ask the AI',
    run: () => togglePalette(),
  });
  services.keymap.add([{ chord: 'Mod+K', command: 'help.palette' }]);
  addMenuItems('help', [cmd('help.palette', 4)]);
  addOverlay('palette', PaletteOverlay);
}
