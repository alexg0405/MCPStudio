import type { Services } from '@app/services';
import { formatChord } from '@core/commands/keymap';
import { getWindowType, openWindow, windowTypes } from '../../workspace/registry';
import { windowHelp } from '../../workspace/window-help';
import { getMenuItems, getMenus, type MenuItem } from '../../shell/menus';
import { TOURS } from '../tours/tour-list';
import { startTour } from '../tours/tour-state';

/** How an entry of the feature map starts: a window it opens, a tour it runs, or a command it triggers. */
export type FeatureKind = 'window' | 'tour' | 'command';

/** One thing AGstudio can do, with where to find it and a way to do it right now. */
export interface FeatureEntry {
  /** Stable name: `window:mixer`, `tour:first-song`, `cmd:file.save`. */
  id: string;
  kind: FeatureKind;
  label: string;
  /** What it is for, in a sentence. */
  hint: string;
  /** Where it lives in the menus ("Playlist"), or how else to reach it. */
  where: string;
  /** Its shortcut on this computer, when it has one. */
  chord?: string;
  /** One click starts it. Absent for a command that needs an argument only a menu or a key can give. */
  run?(): void;
}

/** A part of what AGstudio can do, with everything that belongs to it. */
export interface FeatureArea {
  id: string;
  title: string;
  summary: string;
  windows: FeatureEntry[];
  tours: FeatureEntry[];
  commands: FeatureEntry[];
}

/**
 * How the features are grouped for the page. Windows, tours and command categories are listed by name; anything the app
 * registers that no area names lands in "More" (built below), so the page is complete even before someone files a new
 * feature here (a test lists what is in "More" so it gets filed).
 */
interface AreaDef {
  id: string;
  title: string;
  summary: string;
  windows: readonly string[];
  tours: readonly string[];
  /** Command categories (`CommandDef.category`). */
  categories: readonly string[];
}

const AREAS: readonly AreaDef[] = [
  {
    id: 'beats',
    title: 'Beats and melodies',
    summary: 'Step sequencer, piano roll, patterns, the keys you play with and the MIDI effects (arpeggiator, chords, scale…) between them and the instrument.',
    windows: ['channel-rack', 'piano-roll', 'piano-keyboard', 'keys', 'midi-fx'],
    tours: ['first-song'],
    categories: ['Channels', 'Patterns', 'Piano roll', 'MIDI effects'],
  },
  {
    id: 'arrange',
    title: 'Arranging a song',
    summary: 'Place patterns and audio on the playlist, mark sections, develop and tidy the arrangement.',
    windows: ['playlist'],
    tours: [],
    categories: ['Playlist', 'Song'],
  },
  {
    id: 'transport',
    title: 'Playing and tempo',
    summary: 'Play, stop, loop, tempo, click and which part of the song you hear.',
    windows: [],
    tours: [],
    categories: ['Transport'],
  },
  {
    id: 'recording',
    title: 'Recording and takes',
    summary: 'Microphone and MIDI recording, punch range, takes and comping.',
    windows: [],
    tours: ['record-vocal'],
    categories: ['Audio input', 'Recording', 'Takes'],
  },
  {
    id: 'vocals',
    title: 'Vocals and audio clips',
    summary:
      'Pitch correction, clean-up, alignment, harmonies, audio to MIDI, and gain, fades and tempo of any audio clip.',
    windows: ['pitch-editor', 'vocal-cleanup', 'vocal-align'],
    tours: [],
    categories: ['Audio clip'],
  },
  {
    id: 'harmony',
    title: 'Chords, harmony, lyrics and sheet music',
    summary: 'The chord track, parts written from it, lyrics lined up with the song, and the pattern as printable sheet music.',
    windows: ['chords', 'lyrics', 'sheet-music'],
    tours: ['harmony-chords'],
    categories: ['Chords', 'Lyrics', 'Sheet music'],
  },
  {
    id: 'mixing',
    title: 'Mixing and mastering',
    summary: 'The mixer, snapshots, loudness meters, reference songs, effect chains and the visualizer.',
    windows: ['mixer', 'mix-snapshots', 'meters', 'reference', 'visualizer'],
    tours: ['mix-master'],
    categories: ['Mixer', 'Reference'],
  },
  {
    id: 'sounds',
    title: 'Sounds, samples and plugins',
    summary: 'The sample browser, instrument and effect windows, writing your own plugins, and sharing them as files (My plugins).',
    windows: ['samples', 'plugin', 'plugin-manager'],
    tours: [],
    categories: ['Samples', 'Plugins'],
  },
  {
    id: 'dj',
    title: 'DJ mixing',
    summary: 'Auto-mix your songs, mix live on two decks, and use DJ controllers.',
    windows: ['dj', 'dj-decks', 'dj-controllers'],
    tours: ['dj-mixing'],
    categories: ['DJ'],
  },
  {
    id: 'launcher',
    title: 'Clip launcher',
    summary: 'Launch patterns and clips live, in scenes, and record the performance.',
    windows: ['launcher'],
    tours: ['clip-launcher'],
    categories: ['Launcher'],
  },
  {
    id: 'studio',
    title: 'Studio and MCP',
    summary: 'Ask for changes in your own words, and let Claude Code and other apps control AGstudio.',
    windows: ['assistant'],
    tours: ['studio-mcp'],
    categories: ['Studio'],
  },
  {
    id: 'projects',
    title: 'Projects, versions and export',
    summary: 'Save and open, versions, your projects, undo history, and export as audio, stems, MIDI or video.',
    windows: ['projects', 'versions', 'history'],
    tours: [],
    categories: ['File', 'Edit'],
  },
  {
    id: 'settings',
    title: 'Settings, windows and accessibility',
    summary: 'Layouts, themes, audio devices, touch layout, bigger text, high contrast and keyboard shortcuts.',
    windows: ['settings', 'shortcuts', 'keyboard-help'],
    tours: [],
    categories: ['View', 'Options', 'Accessibility'],
  },
  {
    id: 'help',
    title: 'Help and learning',
    summary: 'This page, the Help window, tours, lessons and what is new.',
    windows: ['help', 'features'],
    tours: ['overview'],
    categories: ['Help'],
  },
];

/** The area that gathers whatever no other area names. */
const MORE_ID = 'more';

/** A window type's title as its title bar shows it. */
function windowLabel(type: string, services: Services): string {
  try {
    const title = getWindowType(type)?.title(null, services);
    if (title) return title;
  } catch {
    /* a title that needs props */
  }
  const words = type.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where each command sits in the menu bar ("Playlist", "File › Export"): the first menu that offers it. */
function menuPaths(): Map<string, string> {
  const paths = new Map<string, string>();
  const walk = (items: MenuItem[], path: string[]) => {
    for (const item of items) {
      if (item.kind === 'command' && !paths.has(item.command)) paths.set(item.command, path.join(' › '));
      else if (item.kind === 'submenu') walk(item.items(), [...path, item.label]);
    }
  };
  for (const menu of getMenus()) walk(getMenuItems(menu.id), [menu.label]);
  return paths;
}

/** Whether a button can run the command by itself (the action search lists it). */
function canRun(services: Services, id: string): boolean {
  const def = services.commands.get(id);
  if (!def || def.palette === false) return false;
  const bindings = services.keymap.all().filter((b) => b.command === id);
  return bindings.length === 0 || bindings.some((b) => b.args === undefined);
}

function windowEntry(type: string, services: Services): FeatureEntry {
  const label = windowLabel(type, services);
  return {
    id: `window:${type}`,
    kind: 'window',
    label,
    hint: windowHelp(type)?.intro ?? `The ${label} window.`,
    where: 'Window',
    ...(type === 'plugin' ? {} : { run: () => void openWindow(services, type) }),
  };
}

function commandEntry(id: string, services: Services, paths: Map<string, string>): FeatureEntry {
  const def = services.commands.get(id)!;
  const chord = services.keymap.chordsFor(id)[0];
  const path = paths.get(id);
  const entry: FeatureEntry = {
    id: `cmd:${id}`,
    kind: 'command',
    label: def.title,
    hint: def.hint ?? def.title,
    where: path ?? (canRun(services, id) ? 'Action search' : 'Studio and shortcuts'),
  };
  if (chord) entry.chord = formatChord(chord, services.platform);
  if (canRun(services, id)) entry.run = () => void services.commands.run(id);
  return entry;
}

/**
 * Everything AGstudio can do, by area, built from what is registered: the window types, the commands (with the menu each
 * one is in and its shortcut) and the guided tours. A feature that registers a window, a command or a tour appears here
 * without anyone editing a list; the areas above only decide where it is shown.
 */
export function buildFeatureMap(services: Services): FeatureArea[] {
  const paths = menuPaths();
  const claimedWindows = new Set(AREAS.flatMap((a) => a.windows));
  const claimedCategories = new Set(AREAS.flatMap((a) => a.categories));
  const claimedTours = new Set(AREAS.flatMap((a) => a.tours));
  const commands = services.commands.list().filter((def) => def.hint);
  const registered = new Set(windowTypes());

  const area = (def: AreaDef): FeatureArea => ({
    id: def.id,
    title: def.title,
    summary: def.summary,
    windows: def.windows.filter((t) => registered.has(t)).map((t) => windowEntry(t, services)),
    tours: def.tours.flatMap((id) => TOURS.filter((t) => t.id === id)).map((t) => tourEntry(t.id, services)),
    commands: commands
      .filter((c) => def.categories.includes(c.category ?? ''))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => commandEntry(c.id, services, paths)),
  });

  const more: FeatureArea = {
    id: MORE_ID,
    title: 'More',
    summary: 'Everything else AGstudio registers.',
    windows: windowTypes()
      .filter((t) => !claimedWindows.has(t))
      .map((t) => windowEntry(t, services)),
    tours: TOURS.filter((t) => !claimedTours.has(t.id)).map((t) => tourEntry(t.id, services)),
    commands: commands
      .filter((c) => !claimedCategories.has(c.category ?? ''))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => commandEntry(c.id, services, paths)),
  };
  const areas = AREAS.map(area).filter((a) => a.windows.length + a.tours.length + a.commands.length > 0);
  return more.windows.length + more.tours.length + more.commands.length > 0 ? [...areas, more] : areas;
}

function tourEntry(id: string, services: Services): FeatureEntry {
  const tour = TOURS.find((t) => t.id === id)!;
  return {
    id: `tour:${tour.id}`,
    kind: 'tour',
    label: tour.title,
    hint: `${tour.summary} (${tour.minutes} min)`,
    where: 'Help › Guided tours',
    run: () => void startTour(services, tour),
  };
}

/** Every entry of every area, flat (the page's search ranks these). */
export function allFeatureEntries(areas: readonly FeatureArea[]): FeatureEntry[] {
  return areas.flatMap((a) => [...a.windows, ...a.tours, ...a.commands]);
}
