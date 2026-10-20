import { createStore } from 'zustand';
import type { Services } from '@app/services';
import { announce } from '../../a11y/announce';
import { tourById } from './tour-list';
import type { Tour } from './tour-types';

/** The tour on screen: which one and which card. Null when no tour runs. */
export interface TourRun {
  tour: Tour;
  step: number;
}

/** Hot updates of the overlay's file keep the running tour (the state lives here). */
export const tourStore = createStore<{ run: TourRun | null }>(() => ({ run: null }));

/** Stops hearing that the demo song ended (the musician opened another project), set while a tour runs on the demo. */
let stopWatchingDemo: (() => void) | null = null;

/**
 * Starts a tour. A tour from the list runs on the demo song: the musician's own project is kept safe and comes back when
 * the tour ends. A one-card spotlight (`demo: false`, as What's new's "Show me" makes) points at the real project's own
 * screen and swaps nothing. A tour that is already running is replaced. Returns false when there is no such tour.
 */
export async function startTour(
  services: Services,
  tourOrId: string | Tour,
  options: { step?: number; demo?: boolean } = {},
): Promise<boolean> {
  const tour = typeof tourOrId === 'string' ? tourById(tourOrId) : tourOrId;
  if (!tour) {
    services.session.getState().toast(`There is no tour called “${String(tourOrId)}”.`, 'error');
    return false;
  }
  const onDemo = options.demo ?? true;
  // The tour being replaced ends first, so its demo song is gone (or kept) before the next one begins.
  if (tourStore.getState().run) endTour(services, { restore: !onDemo, silent: true });
  tourStore.setState({ run: null });
  if (onDemo) {
    await services.demo.begin();
    // Something else replaced the demo (File → New, Open…): the demo has already put the project back, so the tour ends.
    stopWatchingDemo = services.demo.store.subscribe((state) => {
      if (!state.active) endTour(services, { restore: false });
    });
  }
  const first = Math.min(Math.max(0, Math.round(options.step ?? 0)), tour.steps.length - 1);
  tourStore.setState({ run: { tour, step: first } });
  announce(
    `Tour: ${tour.title}. ${tour.steps.length} ${tour.steps.length === 1 ? 'step' : 'steps'}. Press Escape to stop.`,
  );
  return true;
}

/** Moves to a card; before the first or after the last ends the tour. */
export function goToStep(services: Services, index: number): void {
  const run = tourStore.getState().run;
  if (!run) return;
  if (index < 0 || index >= run.tour.steps.length) {
    endTour(services);
    return;
  }
  tourStore.setState({ run: { tour: run.tour, step: index } });
}

/** Ends the tour and, when it ran on the demo song, puts the musician's own project back. */
export function endTour(services: Services, options: { restore?: boolean; silent?: boolean } = {}): void {
  const wasRunning = tourStore.getState().run !== null;
  stopWatchingDemo?.();
  stopWatchingDemo = null;
  tourStore.setState({ run: null });
  const wasOnDemo = services.demo.active;
  if (options.restore !== false) services.demo.end();
  if (wasRunning && !options.silent)
    announce(wasOnDemo ? 'Tour finished. Your project is back as you left it.' : 'Tour finished.');
}
