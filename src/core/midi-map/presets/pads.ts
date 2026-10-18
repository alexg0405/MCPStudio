/**
 * 8×8 pad grids for the clip launcher: Novation Launchpad (the original, S and Mini, "XY layout"; MK2 and MK3 in
 * their note layout) and a generic 36–99 grid (Ableton Push's pad notes).
 *
 * The note layouts and colour values come from Novation's published programmer's references (Launchpad S
 * Programmer's Reference, Launchpad MK2 Programmer's Reference, Launchpad Mini MK3 Programmer's Reference); only
 * addresses and values are used, no code. Each pad sends a note and is lit by the same note, so no explicit LEDs
 * are listed (the launcher lights every pad it has a binding for, see `app/launcher/leds.ts`).
 *
 * The top row is scene 1; the left column is track 1; the right column's buttons launch scenes. The row of buttons
 * above the grid is not mapped.
 */
import { launchSlotId, LAUNCH_PAD_SIZE } from '../targets';
import { emptyMapping, type Binding, type ControllerMapping, type PadPalette } from '../types';
import { bind, note, type ControllerPreset } from './build';

interface Layout {
  /** The note of the pad at 0-based column (track) and row (scene; 0 = the top row). */
  pad(col: number, row: number): number;
  /** The note of the scene button at the right of a row. */
  scene(row: number): number;
}

function padMapping(name: string, preset: string, layout: Layout, palette: PadPalette): ControllerMapping {
  const bindings: Binding[] = [];
  for (let row = 0; row < LAUNCH_PAD_SIZE; row++) {
    for (let col = 0; col < LAUNCH_PAD_SIZE; col++) bindings.push(bind(note(0, layout.pad(col, row)), launchSlotId(col + 1, row + 1)));
    bindings.push(bind(note(0, layout.scene(row)), `launch.scene:${row + 1}`));
  }
  return { ...emptyMapping(name), preset, bindings, ledFromButtons: true, softTakeover: true, pads: palette };
}

/**
 * Launchpad (original), Launchpad S and Launchpad Mini: note = 16 × row + column, the scene buttons are column 8.
 * Light values: bits 0–1 red, bits 4–5 green, plus 12 for "normal" (not double-buffered): off 12, dim amber 29,
 * full yellow 62, full green 60.
 */
const CLASSIC_PALETTE: PadPalette = { empty: 12, loaded: 29, queued: 62, playing: 60 };
const classic: Layout = { pad: (col, row) => row * 16 + col, scene: (row) => row * 16 + 8 };

/**
 * Launchpad MK2 (session note layout) and MK3 / X / Mini MK3 in programmer mode: note = 10 × (8 − row) + column + 1,
 * the scene buttons are the notes 89, 79 … 19. Palette entries: 0 off, 1 dark grey, 13 yellow, 21 green.
 */
const PROGRAMMER_PALETTE: PadPalette = { empty: 0, loaded: 1, queued: 13, playing: 21 };
const programmer: Layout = { pad: (col, row) => 10 * (8 - row) + col + 1, scene: (row) => 10 * (8 - row) + 9 };

/** Ableton Push's pad notes: 36 at the bottom left, 99 at the top right, 8 per row. */
const pushLike: Layout = { pad: (col, row) => 36 + (7 - row) * 8 + col, scene: (row) => 100 + (7 - row) };

export const LAUNCHPAD_MK2_MK3: ControllerPreset = {
  id: 'novation-launchpad-mk2-mk3',
  name: 'Novation Launchpad MK2 / MK3 / X (note layout)',
  match: ['launchpadmk2', 'launchpadminimk3', 'lpminimk3', 'launchpadmk3', 'launchpadx', 'lpx'],
  source: 'Novation Launchpad MK2 and Launchpad Mini MK3 Programmer’s References (note layout and colour palette)',
  notes:
    'A Launchpad MK3 or X must be in its Programmer mode (hold Session, press the top-right pad on a Mini MK3; or choose it in Novation Components). Not mapped: the buttons above the grid.',
  mapping: () => padMapping('Novation Launchpad MK2 / MK3', 'novation-launchpad-mk2-mk3', programmer, PROGRAMMER_PALETTE),
};

export const LAUNCHPAD_CLASSIC: ControllerPreset = {
  id: 'novation-launchpad-classic',
  name: 'Novation Launchpad, S and Mini (original)',
  match: ['launchpads', 'launchpadmini', 'launchpad'],
  source: 'Novation Launchpad S Programmer’s Reference (the XY layout and LED values)',
  notes: 'Not mapped: the buttons above the grid.',
  mapping: () => padMapping('Novation Launchpad', 'novation-launchpad-classic', classic, CLASSIC_PALETTE),
};

export const PAD_GRID_GENERIC: ControllerPreset = {
  id: 'generic-pad-grid-8x8',
  name: 'Generic 8×8 pad grid (notes 36–99)',
  match: [],
  source: 'The pad notes of Ableton Push and most 64-pad controllers (36 at the bottom left, 8 per row)',
  notes: 'Pick it by hand: it is not chosen from a device name. Lights use brightness steps; the scene buttons are the notes 100–107.',
  mapping: () => padMapping('Pad grid', 'generic-pad-grid-8x8', pushLike, { empty: 0, loaded: 20, queued: 64, playing: 127 }),
};

export const PAD_PRESETS: readonly ControllerPreset[] = [LAUNCHPAD_MK2_MK3, LAUNCHPAD_CLASSIC, PAD_GRID_GENERIC];
