/**
 * The DJ controllers of an app: one `DjControllers` per services object, created on first use (by the
 * Controllers feature at startup, never inside a React effect).
 *
 * Wiring the real decks: call `setDecksProvider(...)` from `./decks-source` (or give the services
 * object a `decks` that is a `DecksApi` or a `DecksFactory`). Until then a development build uses a
 * stand-in and the Controllers window says so.
 */
import type { Services } from '../../services';
import { library } from '../library';
import { DjControllers } from './manager';
import { resolveDecks } from './decks-source';

export { setDecksProvider } from './decks-source';
export { DjControllers } from './manager';
export { pickMappingFile, saveMappingFile } from './files';
export type { ControllersState, ControllerDevice, LearnState, LogEntry } from './types';

const instances = new WeakMap<Services, DjControllers>();

export function djControllers(services: Services): DjControllers {
  let c = instances.get(services);
  if (!c) {
    c = new DjControllers({
      getDecks: () => resolveDecks(services),
      runCommand: (id) => void services.commands.run(id),
      launcher: () => services.launcher,
      songs: () => library.getState().songs,
      toast: (message, kind) => services.session.getState().toast(message, kind),
      claim: (isClaimed) => {
        services.midi.ignore = isClaimed;
      },
    });
    instances.set(services, c);
  }
  return c;
}

/** Switches the controllers back on after a reload when the browser already allows MIDI (no prompt appears). */
export async function restoreControllers(services: Services): Promise<void> {
  const c = djControllers(services);
  const wasOn = await c.restore();
  if (!wasOn) return;
  try {
    const status = await navigator.permissions?.query({ name: 'midi' as PermissionName });
    if (status?.state !== 'granted') return;
  } catch {
    return;
  }
  await c.enable();
}
