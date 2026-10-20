import type { Services } from '@app/services';
import { formatChord } from '@core/commands/keymap';
import { KEYBOARD_NAVIGATION, SCREEN_READER_NOTES, spellOutKeys } from '../../a11y/keyboard-help-data';
import { TOUCH_GESTURES } from '../../touch/gestures';
import { getWindowType, openWindow, windowTypes } from '../../workspace/registry';
import { windowHelp } from '../../workspace/window-help';
import { shortcutRows } from '@ui/features/core/shortcut-rows';
import { LESSONS } from '../help/lessons';
import { startLesson } from '../help/lesson-state';
import { TOURS } from '../tours/tour-list';
import { startTour } from '../tours/tour-state';
import { withShortcuts } from '../tours/TourOverlay';

/** The groups the Help window sorts its topics into. */
export type HelpCategory =
  'Tours' | 'Lessons' | 'Windows' | 'Commands' | 'Shortcuts' | 'Keyboard navigation' | 'Touch and gestures';

/** The categories in the order the Help window lists them, each with what it holds. */
export const HELP_CATEGORIES: readonly { id: HelpCategory; blurb: string }[] = [
  { id: 'Tours', blurb: 'Step-by-step walks through one job, pointing at the real controls' },
  { id: 'Lessons', blurb: 'Learn by doing: tasks that check themselves' },
  { id: 'Windows', blurb: 'What each window is for and its mouse and key moves' },
  { id: 'Commands', blurb: 'Every action in the menus, with what it does' },
  { id: 'Shortcuts', blurb: 'Keyboard shortcuts by area' },
  { id: 'Keyboard navigation', blurb: 'Using AGstudio without a mouse, and with a screen reader' },
  { id: 'Touch and gestures', blurb: 'Fingers on a tablet or touch screen' },
];

/** What a topic's button does: start the tour, open the window, run the command. */
export interface HelpAction {
  label: string;
  run(): void;
}

/** One thing the Help window can show: a window, a command, a tour, a list of keys. */
export interface HelpTopic {
  /** Stable name (`window:mixer`, `tour:first-song`, `cmd:file.save`): what links and tests use. */
  id: string;
  category: HelpCategory;
  /** A smaller heading inside the category (a command's own category, "Transport"). */
  group: string | null;
  title: string;
  /** One or two sentences. */
  summary: string;
  /** "How" and "what" pairs: moves of a window, keys of a list, the steps of a tour. */
  moves: readonly (readonly [how: string, what: string])[];
  /** Words people might type that the title and text do not hold. */
  keywords: readonly string[];
  action: HelpAction | null;
}

/** A window type's title as the title bar shows it ("Channel rack"), or the type spelled out when the title needs props. */
function windowTitle(type: string, services: Services): string {
  try {
    const title = getWindowType(type)?.title(null, services);
    if (title) return title;
  } catch {
    /* a title that needs props: fall through */
  }
  const words = type.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function tourTopics(services: Services, chordOf: (command: string) => string | null): HelpTopic[] {
  return TOURS.map((tour) => ({
    id: `tour:${tour.id}`,
    category: 'Tours',
    group: tour.area,
    title: tour.title,
    summary: `${tour.summary} About ${tour.minutes} minutes, on a demo song; your own project comes back afterwards.`,
    moves: tour.steps.map((step) => [step.title, withShortcuts(step.body, chordOf)] as const),
    keywords: ['learn', 'tutorial', 'guide', 'how to', ...tour.keywords],
    action: { label: 'Start the tour', run: () => void startTour(services, tour) },
  }));
}

function lessonTopics(services: Services): HelpTopic[] {
  return LESSONS.map((lesson) => ({
    id: `lesson:${lesson.id}`,
    category: 'Lessons',
    group: null,
    title: lesson.title,
    summary: `${lesson.summary} About ${lesson.minutes} minutes.`,
    moves: lesson.steps.map((step, i) => [String(i + 1), step.text] as const),
    keywords: ['learn', 'tutorial', 'practice', 'how to'],
    action: { label: 'Start the lesson', run: () => void startLesson(services, lesson.id) },
  }));
}

function windowTopics(services: Services): HelpTopic[] {
  const topics: HelpTopic[] = [];
  for (const type of windowTypes()) {
    const help = windowHelp(type);
    if (!help) continue;
    const title = windowTitle(type, services);
    // A plugin window belongs to one instrument or effect, so there is nothing to open on its own.
    const canOpen = type !== 'plugin';
    topics.push({
      id: `window:${type}`,
      category: 'Windows',
      group: null,
      title,
      summary: help.intro,
      moves: help.moves,
      keywords: ['window', 'how to', type.replace(/-/g, ' ')],
      action: canOpen ? { label: `Open ${title}`, run: () => void openWindow(services, type) } : null,
    });
  }
  return topics;
}

/**
 * Whether a button may run a command by itself: the action search lists it, so it works without an argument (it is left
 * out there when every key binding it has passes one).
 */
function runsWithoutArguments(services: Services, id: string): boolean {
  const def = services.commands.get(id);
  if (!def || def.palette === false) return false;
  const bindings = services.keymap.all().filter((b) => b.command === id);
  return bindings.length === 0 || bindings.some((b) => b.args === undefined);
}

function commandTopics(services: Services): HelpTopic[] {
  return services.commands
    .list()
    .filter((def) => def.hint)
    .map((def) => {
      const chord = services.keymap.chordsFor(def.id)[0];
      const shortcut = chord ? formatChord(chord, services.platform) : null;
      return {
        id: `cmd:${def.id}`,
        category: 'Commands' as const,
        group: def.category ?? 'Other',
        title: def.title,
        summary: def.hint ?? '',
        moves: shortcut ? ([['Shortcut', shortcut]] as const) : [],
        keywords: [def.id, def.category ?? ''],
        action: runsWithoutArguments(services, def.id)
          ? { label: 'Run it', run: () => void services.commands.run(def.id) }
          : null,
      };
    });
}

function shortcutTopics(services: Services): HelpTopic[] {
  const rows = shortcutRows(services.commands, services.keymap, services.platform, '', false);
  const byCategory = new Map<string, HelpTopic['moves'][number][]>();
  for (const row of rows) {
    const category = row.def.category ?? 'Other';
    const keys = row.chords.map((c) => formatChord(c, services.platform)).join('  or  ');
    byCategory.set(category, [...(byCategory.get(category) ?? []), [keys, row.def.title] as const]);
  }
  return [...byCategory].map(([category, moves]) => ({
    id: `shortcuts:${category}`,
    category: 'Shortcuts' as const,
    group: null,
    title: `Shortcuts: ${category}`,
    summary: `The keys for ${category.toLowerCase()} actions. Help → Keyboard shortcuts lists them all, and changes them.`,
    moves,
    keywords: ['keys', 'keyboard', 'hotkey', 'shortcut', category],
    action: { label: 'Open the Shortcuts window', run: () => void openWindow(services, 'shortcuts') },
  }));
}

function keyboardTopics(services: Services): HelpTopic[] {
  const platform = services.platform;
  const groups: HelpTopic[] = KEYBOARD_NAVIGATION.map((group) => ({
    id: `keyboard:${group.where}`,
    category: 'Keyboard navigation',
    group: null,
    title: `Keyboard: ${group.where}`,
    summary: 'Keys that work without a mouse.',
    moves: group.moves.map((m) => [spellOutKeys(m.keys, platform), m.what] as const),
    keywords: ['keyboard', 'tab', 'arrow keys', 'accessibility', 'without a mouse'],
    action: { label: 'Open Keyboard navigation', run: () => void openWindow(services, 'keyboard-help') },
  }));
  groups.push({
    id: 'keyboard:screen-reader',
    category: 'Keyboard navigation',
    group: null,
    title: 'Screen reader',
    summary: 'What a screen reader says and how AGstudio helps it.',
    moves: SCREEN_READER_NOTES.map((note, i) => [String(i + 1), note] as const),
    keywords: ['screen reader', 'voiceover', 'nvda', 'jaws', 'blind', 'accessibility', 'aria'],
    action: { label: 'Open Keyboard navigation', run: () => void openWindow(services, 'keyboard-help') },
  });
  return groups;
}

function touchTopics(services: Services): HelpTopic[] {
  return TOUCH_GESTURES.map((group) => ({
    id: `touch:${group.where}`,
    category: 'Touch and gestures',
    group: null,
    title: `Touch: ${group.where}`,
    summary: 'Gestures for a tablet or a touch screen (Options → Touch layout makes everything bigger).',
    moves: group.gestures.map((g) => [g.gesture, g.what] as const),
    keywords: ['touch', 'finger', 'tablet', 'ipad', 'gesture', 'pinch', 'swipe', 'tap'],
    action: { label: 'Open the Shortcuts window', run: () => void openWindow(services, 'shortcuts') },
  }));
}

/**
 * Everything the Help window can show, gathered from what the app has registered: the tours and lessons, the "?" text of
 * every window, the hint of every command, the keyboard shortcuts, the keyboard navigation and the touch gestures. Built
 * when the window opens, so a feature that registers a window or a command is in Help without anyone editing a list.
 */
export function collectHelpTopics(services: Services): HelpTopic[] {
  const chordOf = (command: string) => {
    const chord = services.keymap.chordsFor(command)[0];
    return chord ? formatChord(chord, services.platform) : null;
  };
  return [
    ...tourTopics(services, chordOf),
    ...lessonTopics(services),
    ...windowTopics(services),
    ...commandTopics(services),
    ...shortcutTopics(services),
    ...keyboardTopics(services),
    ...touchTopics(services),
  ];
}
