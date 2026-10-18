/**
 * The types the DJ controllers manager (`manager.ts`) shows to the Controllers window and takes from the app.
 */
import type { LaunchPageDir } from '@core/midi-map/targets';
import type { ControllerMapping } from '@core/midi-map/types';
import type { PadSource } from '../../launcher/leds';
import type { BrowseSong } from './browse';
import type { ResolvedDecks } from './decks-source';
import type { ControllerStorage } from './storage';

/** Where the MIDI permission stands: not asked, asking, allowed, refused, or not available in this browser. */
export type AccessStatus = 'off' | 'asking' | 'ready' | 'denied' | 'unsupported';

/** A connected MIDI controller as the window lists it. */
export interface ControllerDevice {
  /** The MIDI port's name, which is also the key of its mapping. */
  name: string;
  /** Its MIDI output is open, so LEDs can be driven. */
  hasOutput: boolean;
  /** Id of the preset that matches its name, if any. */
  preset: string | null;
}

/** An unfinished "learn a control" session. */
export interface LearnState {
  /** The target being learned; null = pick one (in the list or on a deck). */
  target: string | null;
  /** Learning the shifted function of the control. */
  shifted: boolean;
  /** One target (stops after it) or learn mode (keeps going until Done). */
  session: 'single' | 'mode';
  /** What the window tells the musician to do next. */
  message: string;
}

/** Everything the Controllers window shows. */
export interface ControllersState {
  access: AccessStatus;
  devices: ControllerDevice[];
  /** The device name shown in the window. */
  selected: string | null;
  /** The mapping in use per device name (a preset, or the musician's own). */
  mappings: Record<string, ControllerMapping>;
  /** Names whose mapping the musician changed (kept in this browser). */
  customized: Record<string, true>;
  learn: LearnState | null;
  decks: 'none' | 'loading' | 'ready' | 'missing';
  /** The decks are the development stand-in (the real decks are not wired in). */
  fakeDecks: boolean;
}

/** One line of the test view: a message that arrived, and what it did. */
export interface LogEntry {
  n: number;
  /** performance.now()-style ms. */
  at: number;
  device: string;
  text: string;
  /** What it did ("Deck A: Play / pause"), or why it did nothing. */
  did: string;
}

/** What a controller drives in the clip launcher, and what its lights read (`app/launcher/session.ts` implements it). */
export interface LauncherControl extends PadSource {
  /** 0-based pad positions of the page the pads are on; `down` false is the pad being let go (gate slots stop). */
  padPress(track: number, scene: number, down?: boolean): void;
  padScene(scene: number): void;
  padStop(track: number): void;
  stopAll(): void;
  /** The arrow buttons: the pads move one page over a bigger grid. */
  movePage(dir: LaunchPageDir): void;
  subscribe(fn: () => void): () => void;
}

/** What the controllers manager needs from the app (tests pass their own). */
export interface ControllersOptions {
  requestAccess?: () => Promise<MIDIAccess>;
  /** The live decks (see `decks-source.ts`). */
  getDecks: () => Promise<ResolvedDecks | null>;
  storage?: ControllerStorage;
  runCommand(id: string): void;
  /** The clip launcher the pads drive (null: not available). */
  launcher?: () => LauncherControl | null;
  /** The music library for the browse encoder. */
  songs?: () => readonly BrowseSong[];
  toast?(message: string, kind?: 'error'): void;
  /** Called with a predicate for devices the controllers use, so the keyboard input leaves them alone. */
  claim?(isClaimed: ((device: string) => boolean) | null): void;
  now?(): number;
}
