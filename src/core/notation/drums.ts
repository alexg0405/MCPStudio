/**
 * Drum notation: where each General MIDI drum sits on a five-line percussion staff and what its head looks like (kick on
 * the bottom space, snare on the third space, hi-hat as a cross above the staff), and the names the compact text uses.
 */
import type { HeadShape } from './types';

/** How one drum is written. */
export interface DrumPlace {
  /** Diatonic position on the staff as if it were a treble staff (E4 = 30 is the bottom line, F5 = 38 the top). */
  position: number;
  shape: HeadShape;
  /** A small "o" over the head (open hi-hat). */
  isOpen: boolean;
  /** Played with a foot: written with stems down in their own voice. */
  isFoot: boolean;
  /** What it is called in speech and in the compact text. */
  name: string;
}

const drum = (position: number, shape: HeadShape, name: string, extra: Partial<Pick<DrumPlace, 'isOpen' | 'isFoot'>> = {}): DrumPlace => ({
  position,
  shape,
  name,
  isOpen: extra.isOpen ?? false,
  isFoot: extra.isFoot ?? false,
});

const KICK = drum(31, 'normal', 'kick', { isFoot: true });
const SNARE = drum(35, 'normal', 'snare');
const CRASH = drum(40, 'x', 'crash');
const RIDE = drum(38, 'x', 'ride');
const OTHER = drum(36, 'diamond', 'perc');

/** The General MIDI drum map for the keys that have a place of their own; any other key is written as `OTHER`. */
const PLACES: Readonly<Record<number, DrumPlace>> = {
  35: KICK,
  36: KICK,
  37: drum(35, 'x', 'rim'),
  38: SNARE,
  39: drum(35, 'diamond', 'clap'),
  40: SNARE,
  41: drum(32, 'normal', 'tom-low'),
  42: drum(39, 'x', 'hat'),
  43: drum(32, 'normal', 'tom-low'),
  44: drum(29, 'x', 'pedal-hat', { isFoot: true }),
  45: drum(33, 'normal', 'tom-mid'),
  46: drum(39, 'x', 'open-hat', { isOpen: true }),
  47: drum(34, 'normal', 'tom-mid'),
  48: drum(36, 'normal', 'tom-high'),
  49: CRASH,
  50: drum(37, 'normal', 'tom-high'),
  51: RIDE,
  52: CRASH,
  53: drum(38, 'diamond', 'ride-bell'),
  55: CRASH,
  57: CRASH,
  59: RIDE,
};

/** Where a drum key is written. */
export function drumPlace(gmKey: number): DrumPlace {
  return PLACES[gmKey] ?? OTHER;
}

/** The General MIDI key each drum role plays when its channel is one sample (a kick channel plays its root key, not 36). */
const ROLE_KEYS: Readonly<Record<string, number>> = {
  kick: 36,
  snare: 38,
  clap: 39,
  rim: 37,
  hat: 42,
  'open-hat': 46,
  tom: 45,
  crash: 49,
  perc: 56,
};

/** The GM key a note of a drum channel is written as: a kit channel's keys already are GM, other roles have one key. */
export function gmKeyOf(role: string, key: number): number {
  return role === 'kit' ? key : (ROLE_KEYS[role] ?? 56);
}

/** The drum names the compact text understands, each with the GM key written for it. */
export const DRUM_NAMES: Readonly<Record<string, number>> = {
  kick: 36,
  snare: 38,
  rim: 37,
  clap: 39,
  hat: 42,
  'open-hat': 46,
  'pedal-hat': 44,
  'tom-low': 41,
  'tom-mid': 47,
  'tom-high': 50,
  crash: 49,
  ride: 51,
  'ride-bell': 53,
  perc: 56,
};

/** The text name of a GM key ("kick"), the nearest named drum for the rest. */
export function drumName(gmKey: number): string {
  const place = drumPlace(gmKey);
  if (gmKey === 41 || gmKey === 43) return 'tom-low';
  if (gmKey === 45 || gmKey === 47) return 'tom-mid';
  if (gmKey === 48 || gmKey === 50) return 'tom-high';
  return place.name;
}

/** How a drum is said aloud ("closed hi-hat"). */
export function spokenDrumName(gmKey: number): string {
  const spoken: Record<string, string> = {
    kick: 'kick drum',
    snare: 'snare drum',
    rim: 'side stick',
    clap: 'hand clap',
    hat: 'closed hi-hat',
    'open-hat': 'open hi-hat',
    'pedal-hat': 'pedal hi-hat',
    'tom-low': 'low tom',
    'tom-mid': 'middle tom',
    'tom-high': 'high tom',
    crash: 'crash cymbal',
    ride: 'ride cymbal',
    'ride-bell': 'ride bell',
    perc: 'percussion',
  };
  return spoken[drumName(gmKey)] ?? 'percussion';
}
