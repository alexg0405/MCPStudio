/** The arithmetic of the on-screen Keys panel: which keys exist, where black keys sit, and how hard a touch plays. Pure. */
import type { KeysVelocity } from '@app/stores/prefs';

/** The pitch classes (0 = C) of the black keys. */
const BLACK_CLASSES: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);

/** A key of the piano as laid out on screen: its MIDI key, and where it sits as a share of the keyboard's width. */
export interface PianoKey {
  key: number;
  isBlack: boolean;
  /** Left edge and width, 0-1 of the keyboard's width. */
  left: number;
  width: number;
}

/** A black key is this share of a white key's width. */
const BLACK_WIDTH_OF_WHITE = 0.6;

/** True for the black keys of the piano. */
export function isBlackKey(key: number): boolean {
  return BLACK_CLASSES.has(((key % 12) + 12) % 12);
}

/**
 * The keys from `firstKey` (a C is best) up to and including `lastKey`, white keys evenly spread across the width and
 * black keys straddling the line between their two neighbours. White keys come first, then black (so they draw on top).
 */
export function pianoLayout(firstKey: number, lastKey: number): PianoKey[] {
  const whiteKeys: number[] = [];
  for (let key = firstKey; key <= lastKey; key++) if (!isBlackKey(key)) whiteKeys.push(key);
  const whiteWidth = 1 / Math.max(1, whiteKeys.length);
  const layout: PianoKey[] = whiteKeys.map((key, index) => ({ key, isBlack: false, left: index * whiteWidth, width: whiteWidth }));
  whiteKeys.forEach((key, index) => {
    const blackKey = key + 1;
    if (blackKey > lastKey || !isBlackKey(blackKey)) return;
    const width = whiteWidth * BLACK_WIDTH_OF_WHITE;
    layout.push({ key: blackKey, isBlack: true, left: (index + 1) * whiteWidth - width / 2, width });
  });
  return layout;
}

/** The velocities (0-1) of the fixed settings. */
export const FIXED_VELOCITY: Readonly<Record<Exclude<KeysVelocity, 'position'>, number>> = {
  soft: 0.35,
  medium: 0.7,
  loud: 1,
};

/** The softest and loudest a touch's position makes a note. */
const POSITION_MIN_VELOCITY = 0.25;
const POSITION_MAX_VELOCITY = 1;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * How hard a piano key plays. By position: the lower on the key the finger lands, the louder (a real key is hit near its
 * front). Otherwise the fixed setting. `fromTop` is where the finger is on the key, 0 (top) to 1 (front edge).
 */
export function keyVelocity(setting: KeysVelocity, fromTop: number): number {
  if (setting !== 'position') return FIXED_VELOCITY[setting];
  return POSITION_MIN_VELOCITY + (POSITION_MAX_VELOCITY - POSITION_MIN_VELOCITY) * clamp01(fromTop);
}

/** The softest a drum pad plays when hit at its corner. */
const PAD_CORNER_VELOCITY = 0.4;

/**
 * How hard a drum pad plays. By position: the middle of the pad is the loudest, its corners the softest. `across` and
 * `down` are where the finger is on the pad, 0-1 from the left and from the top.
 */
export function padVelocity(setting: KeysVelocity, across: number, down: number): number {
  if (setting !== 'position') return FIXED_VELOCITY[setting];
  const fromCentre = Math.hypot(2 * clamp01(across) - 1, 2 * clamp01(down) - 1) / Math.SQRT2;
  return 1 - (1 - PAD_CORNER_VELOCITY) * fromCentre;
}

/** The first key of the pad grid: pad 1 plays here (the Drum Pads instrument's first pad, C3 in FL's naming). */
export const FIRST_PAD_KEY = 36;
/** The pads are a grid of this many columns and rows; pad 1 is bottom left, like a drum machine. */
export const PAD_COLUMNS = 4;
export const PAD_ROWS = 4;

/** The MIDI key of the pad at `column` and `row` (row 0 is the top row). */
export function padKey(column: number, row: number): number {
  return FIRST_PAD_KEY + (PAD_ROWS - 1 - row) * PAD_COLUMNS + column;
}
