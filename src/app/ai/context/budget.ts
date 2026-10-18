/**
 * Size budget of the project text. The text grows with the project, so a very large one is shortened, the least
 * important parts first, until it fits. A project under the budget is never shortened (its text is unchanged).
 */
import type { ResolvedFocus } from '../focus';

/** The most characters the project text may have before parts of it are shortened. */
export const CONTEXT_BUDGET = 40_000;
/** The line under a section header when that section was shortened. */
export const SHORT_NOTE = '(details shortened: the project is very large)';
/** Parameter values kept per plugin, when shortened. */
export const SHORT_VALUES = 3;
/** Playlist runs kept per track, when shortened. */
export const SHORT_RUNS = 8;
/** Patterns kept in full when shortened. */
export const FULL_PATTERNS = 60;
/** Channels kept in full when shortened. */
export const FULL_CHANNELS = 80;

/** What a render shortens. Each step in `SHORTENING_STEPS` adds one more part, in the order the budget cuts them. */
export interface Shortening {
  /** Notes of patterns other than the current one: a count and pitch range instead of per channel. */
  otherNotes: boolean;
  /** Plugin settings beyond the first few: names only. */
  settings: boolean;
  /** Playlist runs beyond the first few per track. */
  runs: boolean;
  /** Channels that play nowhere: one line. */
  silentChannels: boolean;
  /** Patterns beyond the most relevant ones: id and name only. */
  patternsCompact: boolean;
  /** Channels beyond the ones the full patterns use (and the selected one): one line each. */
  channelsCompact: boolean;
}

/** Nothing shortened. */
export const FULL: Shortening = {
  otherNotes: false,
  settings: false,
  runs: false,
  silentChannels: false,
  patternsCompact: false,
  channelsCompact: false,
};

/** The renders to try, each shortening one more part than the one before. */
export const SHORTENING_STEPS: Shortening[] = [
  FULL,
  { ...FULL, otherNotes: true },
  { ...FULL, otherNotes: true, settings: true },
  { ...FULL, otherNotes: true, settings: true, runs: true },
  { ...FULL, otherNotes: true, settings: true, runs: true, silentChannels: true },
  { ...FULL, otherNotes: true, settings: true, runs: true, silentChannels: true, patternsCompact: true },
  {
    ...FULL,
    otherNotes: true,
    settings: true,
    runs: true,
    silentChannels: true,
    patternsCompact: true,
    channelsCompact: true,
  },
];

/** A section of the project text that can be cut. */
export type Section = 'patterns' | 'channels' | 'mixer' | 'playlist';

/** One render: what it shortens, which sections it actually cut (only those say so), and the focus. */
export interface ContextRender {
  shorten: Shortening;
  cut: Set<Section>;
  focus: ResolvedFocus | null;
}

/** A render that shortens nothing. */
export const fullRender = (focus: ResolvedFocus | null = null): ContextRender => ({
  shorten: FULL,
  cut: new Set(),
  focus,
});

/** The note under a section header, when the render cut that section. */
export const cutNote = (render: ContextRender, section: Section): string[] =>
  render.cut.has(section) ? [SHORT_NOTE] : [];
