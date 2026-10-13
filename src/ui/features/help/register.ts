import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { showWelcome, startTour, TourOverlay, WelcomeOverlay } from './Help';

/**
 * Getting started: the welcome dialog (opens by itself the first time AGstudio starts), a guided
 * tour of the main windows, and the tooltip switch.
 */
export function register(services: Services): void {
  const { commands } = services;
  commands.register({
    id: 'help.welcome',
    title: 'Getting started',
    category: 'Help',
    hint: 'What each part of AGstudio does, in one screen',
    run: () => showWelcome(),
  });
  commands.register({
    id: 'help.tour',
    title: 'Take the tour',
    category: 'Help',
    hint: 'A step-by-step look at the main windows',
    run: () => startTour(),
  });
  commands.register({
    id: 'options.tooltips',
    title: 'Show tooltips',
    category: 'Options',
    hint: 'Explain a control in a small bubble when you point at it for a moment',
    run: (s) => s.prefs.getState().set({ tooltips: !s.prefs.getState().tooltips }),
    checked: (s) => s.prefs.getState().tooltips,
  });
  addMenuItems('help', [cmd('help.welcome', 1), cmd('help.tour', 2), sep(3)]);
  addMenuItems('options', [sep(89), cmd('options.tooltips', 90)]);
  addOverlay('help-welcome', WelcomeOverlay);
  addOverlay('help-tour', TourOverlay);
}
