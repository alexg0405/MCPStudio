/**
 * Pieces of the mix recipes that the vocal chains use too (kept apart so `recipes.ts` can use the chains'
 * Vocals bus without the two files importing each other): the built-in plugin ids, what one effect of a
 * bus or chain is, and EQ Pro's band params.
 */
import type { ParamValue } from '@agstudio/sdk';
import type { BusRole } from './layout';

export const EQ_PRO = 'agstudio.eq-pro';
export const COMPRESSOR = 'agstudio.compressor';
export const SATURATOR = 'agstudio.saturator';
export const DUCKER = 'agstudio.ducker';
export const REVERB = 'agstudio.reverb';
export const DELAY = 'agstudio.delay';
export const LIMITER = 'agstudio.limiter';
export const MAXIMIZER = 'agstudio.maximizer';

/** One effect of a bus: a plugin, a preset of it, settings on top, and where its sidechain listens. */
export interface FxRecipe {
  pluginId: string;
  preset?: string;
  params?: Record<string, ParamValue>;
  /** The bus that keys it (the Kick bus for ducking). */
  sidechain?: BusRole;
  /** What it is, for the chat ("tape saturation"). */
  label: string;
}

/** EQ Pro bands: band number → on, type, frequency (Hz), gain (dB), Q. */
type Band = { type: string; freq: number; gain?: number; q?: number };
export function eqBands(bands: Record<number, Band>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [n, b] of Object.entries(bands)) {
    out[`b${n}On`] = true;
    out[`b${n}Type`] = b.type;
    out[`b${n}Freq`] = b.freq;
    if (b.gain !== undefined) out[`b${n}Gain`] = b.gain;
    if (b.q !== undefined) out[`b${n}Q`] = b.q;
  }
  return out;
}
