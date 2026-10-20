import type { Services } from '@app/services';

/**
 * What a tour step points at, as a plain string a person can read in the tour's source:
 *   `tour:<name>`   an element with `data-tour="<name>"` (the transport, the browser, a window's own anchor)
 *   `window:<type>` the floating window of that type (`data-window-type`)
 *   `menu:<id>`     a label in the menu bar (`data-menu`): File, Edit, Add, Playlist, View, Options, Help
 *   `slot:<id>`     a part of the toolbar (`data-slot`): assistant, input, master-volume, window-buttons…
 */
export type TourTarget = `tour:${string}` | `window:${string}` | `menu:${string}` | `slot:${string}`;

/** A button on a step that does the thing the step describes, such as opening the Pitch editor. */
export interface TourTryIt {
  /** What the button says: "Open the Pitch editor". */
  label: string;
  /** The command it runs. Only commands that open a window or pick a tool: a tour never edits the demo song for you. */
  command: string;
  args?: unknown;
}

/** One card of a tour: where it points and what it says. */
export interface TourStep {
  /** Unique within its tour (what the tests and the AI name). */
  id: string;
  target: TourTarget;
  title: string;
  /** Plain words, one short paragraph. `{key:command}` becomes that command's shortcut on this computer. */
  body: string;
  /** Makes the target appear (opens the window, shows the browser) before the card is placed. */
  prepare?(services: Services): void;
  tryIt?: TourTryIt;
}

/** The areas the Help window and the Features page group tours under. */
export type TourArea = 'Getting started' | 'Recording' | 'Performing' | 'Harmony' | 'Mixing' | 'Studio';

/** A guided tour: a few cards, each pointing at a real control, run on a demo song. */
export interface Tour {
  id: string;
  title: string;
  /** One sentence for lists: what you will be able to do afterwards. */
  summary: string;
  minutes: number;
  area: TourArea;
  /** Words people might type to look for it, besides its title. */
  keywords: readonly string[];
  /**
   * The window types whose "?" panel offers this tour. Every window type belongs to exactly one tour (a test checks).
   */
  windows: readonly string[];
  steps: readonly TourStep[];
}
