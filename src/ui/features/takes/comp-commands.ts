/** Commands on a recording's whole comp: flatten it, set its crossfade, open or fold its takes. */
import { flatten, setCrossfade, setTakesOpen } from '@app/actions/comp';
import type { Services } from '@app/services';
import { DEFAULT_CROSSFADE_MS, MAX_CROSSFADE_MS } from '@core/audio/comp';
import { crossfadeDialog } from './menus';
import { GROUP_ARGS, hasTakeGroup, takeTarget, type TakeArgs } from './target';

/** Registers `comp.flatten`, `comp.crossfade` and `comp.toggleTakes`. */
export function registerCompCommands(services: Services): void {
  const { commands } = services;
  commands.register<TakeArgs>({
    id: 'comp.flatten',
    title: 'Flatten comp',
    category: 'Takes',
    hint: 'Keep what the comp plays as ordinary clips and delete the take tracks; with merge, render it into one new clip (undo brings the takes back)',
    argsHint: `${GROUP_ARGS}; merge: true renders the comp into one clip`,
    enabled: hasTakeGroup,
    run: async (s, args) => {
      const target = takeTarget(s, args);
      if (!target) return;
      const isMerge = args?.merge === true;
      try {
        if (await flatten(s, target.group.id, isMerge)) {
          s.session
            .getState()
            .toast(isMerge ? 'Flattened and merged the comp into one clip.' : 'Flattened the comp: the takes are gone, the comp stays as ordinary clips.');
        }
      } catch (error) {
        s.session.getState().toast(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  commands.register<TakeArgs>({
    id: 'comp.crossfade',
    title: 'Comp crossfade…',
    category: 'Takes',
    hint: `How long two takes fade across each other where the comp changes take (default ${DEFAULT_CROSSFADE_MS} ms); the comp is rebuilt with it`,
    argsHint: `{ ms: 0–${MAX_CROSSFADE_MS} } with optional clip or group; without ms: a dialog`,
    enabled: hasTakeGroup,
    run: async (s, args) => {
      const target = takeTarget(s, args);
      if (!target) return;
      if (typeof args?.ms === 'number') setCrossfade(s, target.group.id, args.ms);
      else await crossfadeDialog(s, target.group.id, target.group.crossfadeMs);
    },
  });
  commands.register<TakeArgs>({
    id: 'comp.toggleTakes',
    title: 'Open or fold the takes',
    category: 'Takes',
    hint: 'Show or hide the take tracks under a recording’s comp track (the ▸ on the comp track does the same)',
    argsHint: `${GROUP_ARGS}; open: true or false to set it (default: switch)`,
    enabled: hasTakeGroup,
    run: (s, args) => {
      const target = takeTarget(s, args);
      if (target) setTakesOpen(s, target.group.id, typeof args?.open === 'boolean' ? args.open : undefined);
    },
  });
}
