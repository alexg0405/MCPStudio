import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import type { ViewActions, ViewState } from '@app/stores/view';
import type { SessionActions, SessionState } from '@app/stores/session';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices() outside <ServicesProvider>');
  return services;
}

export function useView<T>(selector: (s: ViewState & ViewActions) => T): T {
  return useStore(useServices().view, selector);
}

export function useSession<T>(selector: (s: SessionState & SessionActions) => T): T {
  return useStore(useServices().session, selector);
}
