import type { Tour, TourStep } from './tour-types';

/**
 * A one-card tour for a single control ("Show me" in What's new): it opens what the step points at and highlights it. It
 * runs on the musician's own project (nothing is swapped), so it is started with `demo: false`.
 */
export function spotlight(step: TourStep): Tour {
  return {
    id: `spotlight:${step.id}`,
    title: step.title,
    summary: step.body,
    minutes: 0,
    area: 'Getting started',
    keywords: [],
    windows: [],
    steps: [step],
  };
}
