import { CLIP_LAUNCHER } from './data/clip-launcher';
import { DJ_MIXING } from './data/dj-mixing';
import { FIRST_SONG } from './data/first-song';
import { HARMONY_CHORDS } from './data/harmony-chords';
import { MIX_MASTER } from './data/mix-master';
import { OVERVIEW } from './data/overview';
import { RECORD_VOCAL } from './data/record-vocal';
import { STUDIO_MCP } from './data/studio-mcp';
import type { Tour } from './tour-types';

/** Every guided tour, in the order the Help menu lists them. */
export const TOURS: readonly Tour[] = [
  OVERVIEW,
  FIRST_SONG,
  RECORD_VOCAL,
  DJ_MIXING,
  CLIP_LAUNCHER,
  HARMONY_CHORDS,
  MIX_MASTER,
  STUDIO_MCP,
];

/** The tour with this id, if there is one. */
export function tourById(id: string): Tour | undefined {
  return TOURS.find((tour) => tour.id === id);
}

/** The tour a window's "?" panel offers: the one that lists the window type. */
export function tourForWindow(type: string): Tour | undefined {
  return TOURS.find((tour) => tour.windows.includes(type));
}
