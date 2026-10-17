import { allChains, chainTarget } from '@app/actions/chains';
import { importChainFile } from '@app/chains';
import type { Services } from '@app/services';
import { insertLabel } from '@core/query/mixer';
import { addContextMenuItems } from '../../context-menus';
import { addBrowserSection } from '../../shell/Browser';
import { addMenuItems, submenu, type MenuItem } from '../../shell/menus';
import { chainMenuEntries, runChainCommand, saveChainDialog, type ChainArgs } from './chain-actions';
import { ChainsSection } from './ChainsSection';
import { PresetsSection } from './PresetsSection';

/**
 * Presets in the browser (yours, and a search over every plugin's) and effect chains (a row of effects
 * put on a mixer track in one step: the vocal chains and yours). The preset bar lives in plugin windows.
 */
export function register(services: Services): void {
  addBrowserSection({ id: 'presets', title: 'Presets', icon: 'sparkle', order: 12, component: PresetsSection });
  addBrowserSection({ id: 'chains', title: 'Chains', icon: 'mic', order: 13, component: ChainsSection });

  services.commands.register<ChainArgs>({
    id: 'mixer.applyChain',
    title: 'Put an effect chain on the selected mixer track',
    category: 'Mixer',
    hint: 'Put a chain of effects (a vocal chain, or one of yours) on the track selected in the mixer; a track with effects is asked whether to replace them or add after them',
    argsHint:
      '{ chain: "Clean pop vocal" | "Rap vocal" | "Airy ballad" | "Lo-fi vocal" | "Trap auto-tune vocal" | "Podcast voice" | one of your chain names, mode?: "replace" | "append", insert?: track name } (default: the selected track)',
    run: (s, args) => runChainCommand(s, args),
  });
  services.commands.register<{ name?: string } | string | void>({
    id: 'mixer.saveInsertChain',
    title: 'Save the selected track’s chain',
    category: 'Mixer',
    hint: 'Keep the effects on the track selected in the mixer, with their settings, as a chain of your own',
    argsHint: '{ name: "My vocal" } (leave out to be asked for a name)',
    run: (s, args) => {
      const name = typeof args === 'string' ? args : (args?.name ?? '');
      return saveChainDialog(s, chainTarget(s), name);
    },
  });
  services.commands.register({
    id: 'mixer.importChain',
    title: 'Import an effect chain file',
    category: 'Mixer',
    hint: 'Add a .agchain file (a chain someone shared, or one you exported) to your chains',
    // It opens a file picker: the browser allows that right after a click, so the studio asks for one.
    gesture: true,
    run: (s) => void importChainFile(s),
  });

  // Add ▸ Effect chain: any chain onto the selected track.
  const chainItems = (): MenuItem[] => {
    const s = services;
    const target = chainTarget(s);
    const where = insertLabel(s.doc.getState().project, target);
    return [
      ...allChains(s).map(
        (c, i): MenuItem => ({
          kind: 'command',
          command: 'mixer.applyChain',
          order: i,
          label: `${c.name}${c.source === 'user' ? ' ★' : ''}`,
          args: { chain: c.name },
        }),
      ),
      { kind: 'separator', order: 100 },
      { kind: 'command', command: 'mixer.saveInsertChain', order: 101, label: `Save ${where}’s chain…` },
      { kind: 'command', command: 'mixer.importChain', order: 102, label: 'Import a chain file…' },
    ];
  };
  addMenuItems('add', [submenu('chains', 'Effect chain on the selected track', 55, chainItems)]);

  // Right-click a mixer track: chains for that track.
  addContextMenuItems('mixer.strip', ({ insertId }, s) => [
    { kind: 'submenu', label: 'Effect chains', hint: 'Put a vocal chain (or one of yours) on this track, or save its effects as a chain', items: () => chainMenuEntries(s, insertId) },
  ]);
}
