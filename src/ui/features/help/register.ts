import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { setWindowHelp } from '../../workspace/window-help';
import { showWelcome, startTour, TourOverlay, WelcomeOverlay } from './Help';
import { LessonOverlay, startLesson } from './Lesson';
import { LESSONS } from './lessons';
import { windowHelpTexts } from './window-help';

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
  commands.register<string>({
    id: 'help.lesson',
    title: 'Start a lesson',
    category: 'Help',
    hint: 'Learn by doing: a few steps that check themselves as you go',
    argsHint: LESSONS.map((l) => `'${l.id}' (${l.title})`).join(', '),
    palette: false,
    run: (s, id) => void startLesson(s, String(id ?? 'first-beat')),
  });
  addMenuItems('help', [
    cmd('help.welcome', 1),
    cmd('help.tour', 2),
    {
      kind: 'dynamic',
      id: 'lessons',
      order: 2.5,
      entries: () => [
        {
          label: 'Lessons',
          run: () => {},
          children: LESSONS.map((l, i) => ({
            label: `${i + 1}. ${l.title} (${l.minutes} min)`,
            hint: l.summary,
            run: () => void startLesson(services, l.id),
          })),
        },
      ],
    },
    sep(3),
  ]);
  addOverlay('help-lesson', LessonOverlay);
  // The "?" in each window's title bar.
  const mac = services.platform === 'mac';
  for (const [type, help] of Object.entries(windowHelpTexts(mac ? '⌘' : 'Ctrl', mac ? '⌥' : 'Alt')))
    setWindowHelp(type, help);
  addMenuItems('options', [sep(89), cmd('options.tooltips', 90)]);
  addOverlay('help-welcome', WelcomeOverlay);
  addOverlay('help-tour', TourOverlay);
}
