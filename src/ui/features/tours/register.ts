import type { Services } from '@app/services';
import { addMenuItems } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { addWindowHelpLink } from '../../workspace/window-help';
import { TourOverlay } from './TourOverlay';
import { TOURS } from './tour-list';
import { endTour, startTour, tourStore } from './tour-state';

/**
 * Guided tours: short card-by-card walks through one job (a first song, a vocal, DJ mixing…), each card pointing at the
 * real control. They run on a demo song and put the musician's own project back at the end. The Help menu lists them,
 * the action search finds them ("Learn: …"), every window's "?" offers the one for that window, and Studio can start
 * one with `tour.start`.
 */
export function register(services: Services): void {
  const { commands } = services;
  commands.register<string>({
    id: 'tour.start',
    title: 'Take a guided tour',
    category: 'Help',
    hint: 'A step-by-step walk through one job, with each step pointing at the real control (it runs on a demo song and gives your project back)',
    argsHint: TOURS.map((tour) => `'${tour.id}' (${tour.title})`).join(', '),
    palette: false,
    run: (s, id) => void startTour(s, String(id ?? 'overview')),
  });
  commands.register({
    id: 'tour.stop',
    title: 'Stop the tour',
    category: 'Help',
    hint: 'End the guided tour and put your own project back',
    enabled: () => tourStore.getState().run !== null,
    run: (s) => endTour(s),
  });

  addMenuItems('help', [
    {
      kind: 'dynamic',
      id: 'tours',
      order: 2.7,
      entries: () => [
        {
          label: 'Guided tours',
          hint: 'Step-by-step walks through one job each: a first song, a vocal, DJ mixing, the clip launcher, chords, mastering, Studio',
          run: () => {},
          children: TOURS.map((tour) => ({
            label: `${tour.title} (${tour.minutes} min)`,
            hint: tour.summary,
            run: () => void startTour(services, tour),
          })),
        },
      ],
    },
  ]);
  addOverlay('tour', TourOverlay);

  // Every window's "?" offers the tour that covers it.
  for (const tour of TOURS)
    for (const type of tour.windows)
      addWindowHelpLink(type, {
        label: `Take the tour: ${tour.title}`,
        hint: `${tour.summary} (${tour.minutes} min, on a demo song; your project comes back afterwards)`,
        run: () => void startTour(services, tour),
      });
}
