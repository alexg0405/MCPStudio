import type { Services } from '@app/services';
import { addActionProvider, type ActionEntry } from '../../shell/actions';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { getWindowType, openWindow, registerWindowType, windowTypes } from '../../workspace/registry';
import { ALL_WINDOWS, addWindowHelpLink, setWindowHelp, windowHelp } from '../../workspace/window-help';
import { startLesson } from '../help/lesson-state';
import { LESSONS } from '../help/lessons';
import { TOURS } from '../tours/tour-list';
import { startTour } from '../tours/tour-state';
import { FeaturesWindow } from './FeaturesWindow';
import { HelpWindow, type HelpProps } from './HelpWindow';

/** What `help.open` accepts: words to search for, or where to look. */
type HelpArgs = string | { query?: string; topic?: string; category?: string };

/** Words people type when they want to be taught something. */
const LEARN_WORDS = ['learn', 'tutorial', 'how to', 'guide', 'teach', 'show me'];

/** A tour ranks a little above a lesson, and a lesson above the page of a window, when a search matches them equally well. */
const TOUR_BOOST = 2;
const LESSON_BOOST = 1;

/** The props the Help window opens with for what `help.open` was given. */
function helpProps(args: HelpArgs | undefined): HelpProps {
  if (typeof args === 'string') return args.trim() ? { query: args.trim() } : {};
  const props: HelpProps = {};
  if (args?.query) props.query = args.query;
  if (args?.topic) props.topic = args.topic;
  if (args?.category) props.category = args.category;
  return props;
}

/** The "Learn: …" rows of the action search: a tour, a lesson or the help of a window, each one click from its start. */
function learnEntries(services: Services): ActionEntry[] {
  const entries: ActionEntry[] = [];
  for (const tour of TOURS)
    entries.push({
      key: `learn:tour:${tour.id}`,
      label: `Learn: ${tour.title}`,
      path: ['Help', 'Guided tours'],
      hint: `${tour.summary} (${tour.minutes} min tour, on a demo song)`,
      keywords: [...LEARN_WORDS, 'tour', ...tour.keywords],
      boost: TOUR_BOOST,
      run: () => void startTour(services, tour),
    });
  for (const lesson of LESSONS)
    entries.push({
      key: `learn:lesson:${lesson.id}`,
      label: `Learn: ${lesson.title}`,
      path: ['Help', 'Lessons'],
      hint: `${lesson.summary} (${lesson.minutes} min lesson that checks itself)`,
      keywords: [...LEARN_WORDS, 'lesson', 'practice'],
      boost: LESSON_BOOST,
      run: () => void startLesson(services, lesson.id),
    });
  for (const [type, title] of windowTitles(services))
    entries.push({
      key: `learn:window:${type}`,
      label: `Learn: ${title}`,
      path: ['Help', 'Windows'],
      hint: windowHelp(type)?.intro ?? `How the ${title} window works`,
      keywords: [...LEARN_WORDS, 'window', type.replace(/-/g, ' ')],
      run: () => void openWindow(services, 'help', { topic: `window:${type}` }),
    });
  return entries;
}

/** The registered windows that have a "?" text, with their titles (read when asked: this feature registers before some windows). */
function windowTitles(services: Services): [string, string][] {
  const out: [string, string][] = [];
  for (const type of windowTypes()) {
    if (!windowHelp(type)) continue;
    let title = '';
    try {
      title = getWindowType(type)?.title(null, services) ?? '';
    } catch {
      /* a title that needs props */
    }
    out.push([type, title || type.replace(/-/g, ' ')]);
  }
  return out;
}

/**
 * The Help window (search everything AGstudio explains), the Features page (everything it can do, by area), the "Learn: …"
 * rows of the action search and the "More in Help" link under every window's "?".
 */
export function register(services: Services): void {
  const { commands } = services;
  registerWindowType<HelpProps>({
    type: 'help',
    title: () => 'Help and tours',
    component: HelpWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 400), y: 40, w: 800, h: Math.min(580, ws.h - 80) }),
    minSize: { w: 320, h: 260 },
  });
  registerWindowType({
    type: 'features',
    title: () => 'Features',
    component: FeaturesWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 420), y: 36, w: 840, h: Math.min(600, ws.h - 72) }),
    minSize: { w: 320, h: 260 },
  });

  commands.register<HelpArgs | undefined>({
    id: 'help.open',
    title: 'Help and tours…',
    category: 'Help',
    hint: 'Search everything AGstudio explains: tours, lessons, what each window does, every action, shortcuts and gestures',
    argsHint:
      'optional: words to search for, or { query, topic ("window:mixer", "tour:first-song", "cmd:file.save"), category ("Tours", "Windows", "Commands", "Shortcuts", "Keyboard navigation", "Touch and gestures", "Lessons") }',
    run: (s, args) => void openWindow(s, 'help', helpProps(args)),
  });
  commands.register({
    id: 'help.features',
    title: 'Features',
    category: 'Help',
    hint: 'Everything AGstudio can do, by area, with a button that starts each one and the menu it is in',
    run: (s) => void openWindow(s, 'features'),
  });
  addMenuItems('help', [cmd('help.open', 3.2), cmd('help.features', 3.4), sep(3.9)]);

  addActionProvider('help.learn', learnEntries);

  setWindowHelp('help', {
    intro: 'Search everything AGstudio explains, or browse by category.',
    moves: [
      ['Type in the search box', 'Find tours, windows, actions, shortcuts and gestures by what they do'],
      ['Category buttons', 'Show one kind of topic: Tours, Windows, Commands…'],
      ['Click a topic', 'Read it; its button starts the tour, opens the window or runs the action'],
      ['Up and Down in the list', 'Move between topics'],
    ],
  });
  setWindowHelp('features', {
    intro:
      'Everything AGstudio can do, by area. It is built from what the app has registered, so it is always complete.',
    moves: [
      ['Window and tour buttons', 'Open that window or start that tour'],
      ['N actions', 'Open the list of actions of an area, with the menu each one is in and its shortcut'],
      ['Run', 'Do that action now (those that need a choice are used from their menu)'],
      ['Search box', 'Show only the features that match'],
    ],
  });
  // Windows other features leave without a "?" text still get one here.
  setWindowHelp('shortcuts', {
    intro:
      'Every keyboard shortcut, and the keyboard and touch moves that are not shortcuts. Change any shortcut to your own.',
    moves: [
      ['Search box', 'Find a command by its name or its keys'],
      ['+ next to a shortcut', 'Click, then press the keys you want it to have'],
      ['× on a key', 'Remove that shortcut'],
      ['Reset', 'Go back to the built-in shortcut'],
    ],
  });
  setWindowHelp('mix-snapshots', {
    intro:
      'Saved copies of the whole mix: levels, pans, mutes, sends and effect settings. Recall one to hear it again.',
    moves: [
      ['Save', 'Keep the mix as it is now, under a name'],
      ['Recall', 'Put a saved mix back in one undo step'],
      ['A and B, then A/B', 'Switch between two saved mixes while the song plays, without clicks'],
      ['Compare', 'See which tracks differ between two snapshots'],
    ],
  });

  // Under every window's how-to: its page in the Help window.
  addWindowHelpLink(ALL_WINDOWS, {
    label: 'More in Help',
    hint: 'Open this window’s page in the Help window: the same moves, searchable, with the related tour',
    run: (type) => void openWindow(services, 'help', { topic: `window:${type}` }),
  });
}
