import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import type { ViewActions, ViewState } from '@app/stores/view';
import type { SessionActions, SessionState } from '@app/stores/session';
import type { Project } from '@core/model/types';
import type { HistoryStatus } from '@core/history/history';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices() outside <ServicesProvider>');
  return services;
}

/** Reads from the project document. Keep selectors narrow: they decide what re-renders. */
export function useDoc<T>(selector: (project: Project) => T): T {
  return useStore(useServices().doc, (s) => selector(s.project));
}

export function useView<T>(selector: (s: ViewState & ViewActions) => T): T {
  return useStore(useServices().view, selector);
}

export function useSession<T>(selector: (s: SessionState & SessionActions) => T): T {
  return useStore(useServices().session, selector);
}

export function useHistoryStatus(): HistoryStatus {
  const { history } = useServices();
  const subscribe = useCallback((fn: () => void) => history.onStatus(fn), [history]);
  const snap = useSyncExternalStore(subscribe, () => JSON.stringify(history.status()));
  return JSON.parse(snap) as HistoryStatus;
}

/** Engine playing flag and state (re-renders on transport start/stop and context state changes). */
export function useEngineStatus(): { playing: boolean; state: string } {
  const { engine } = useServices();
  const subscribe = useCallback((fn: () => void) => engine.subscribe(fn), [engine]);
  const snap = useSyncExternalStore(subscribe, () => `${engine.playing ? 1 : 0}:${engine.state}`);
  const [playing, state] = snap.split(':');
  return { playing: playing === '1', state: state ?? 'suspended' };
}
