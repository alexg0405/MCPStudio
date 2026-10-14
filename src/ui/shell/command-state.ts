import { useCallback, useSyncExternalStore } from 'react';
import { useServices } from '../services-context';

/** A command's enabled/checked state; re-renders only when it actually changes. */
export function useCommandState(id: string) {
  const services = useServices();
  const subscribe = useCallback((fn: () => void) => services.subscribe(fn), [services]);
  const snap = useSyncExternalStore(
    subscribe,
    () => `${services.commands.isEnabled(id) ? 1 : 0}${services.commands.isChecked(id) ? 1 : 0}`,
  );
  return { enabled: snap[0] === '1', checked: snap[1] === '1' };
}
