import type { RelEncoding } from '../relative';
import type { DeckLetter } from '../targets';
import { emptyMapping, type Binding, type ControllerMapping, type InputSpec, type LedBinding, type PadPalette } from '../types';

export interface ControllerPreset {
  id: string;
  /** What the musician sees. */
  name: string;
  /** Lower-case, letters and digits only: a device whose name (normalized the same way) contains one of these gets this preset. */
  match: readonly string[];
  /** Where the MIDI values come from. */
  source: string;
  /** What is not covered, in plain words (shown next to the preset). */
  notes: string;
  mapping(): ControllerMapping;
}

export const note = (channel: number, n: number): InputSpec => ({ type: 'note', channel, note: n });
export const cc = (channel: number, c: number): InputSpec => ({ type: 'cc', channel, cc: c });
export const cc14 = (channel: number, c: number): InputSpec => ({ type: 'cc14', channel, cc: c });
export const rel = (channel: number, c: number, encoding: RelEncoding): InputSpec => ({ type: 'rel', channel, cc: c, encoding });

export const bind = (input: InputSpec, target: string, extra: Partial<Binding> = {}): Binding => ({ input, target, ...extra });

/** An LED that lives at a note: lit with `on`, off with `off` (default 0). */
export const ledNote = (state: string, channel: number, n: number, on = 0x7f, off?: number): LedBinding => ({
  state,
  out: { type: 'note', channel, number: n, on, ...(off !== undefined ? { off } : {}) },
});

export const DECKS_AB: readonly DeckLetter[] = ['A', 'B'];

export function mappingOf(name: string, preset: string, bindings: Binding[], leds: LedBinding[]): ControllerMapping {
  return { ...emptyMapping(name), preset, bindings, leds, ledFromButtons: false, softTakeover: true };
}
