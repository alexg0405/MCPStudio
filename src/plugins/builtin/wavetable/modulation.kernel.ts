import { clamp } from '@agstudio/sdk/worklet';
import { MOD_SLOTS } from './params';
import type { ParamSnapshot } from './snapshot.kernel';
import type { WavetableVoice } from './voice.kernel';

// Mod sources and destinations: positions in MOD_SOURCES and MOD_TARGETS (params.ts).
const SOURCE_NONE = 0;
const SOURCE_MOD_ENV = 1;
const SOURCE_LFO1 = 2;
const SOURCE_LFO2 = 3;
const SOURCE_VELOCITY = 4;
const SOURCE_WHEEL = 5;
const SOURCE_KEY = 6;

export const DEST_PITCH = 0;
export const DEST_OSC1_POSITION = 1;
export const DEST_OSC2_POSITION = 2;
export const DEST_CUTOFF = 3;
export const DEST_RESONANCE = 4;
export const DEST_AMP = 5;
export const DEST_PAN = 6;
export const DEST_LFO1_RATE = 7;
export const DEST_LFO2_RATE = 8;
/** How many destinations there are (the size of the sums `sumModMatrix` fills). */
export const DESTINATION_COUNT = 9;

/** The notes either side of middle C (60) that count as the full range of the Key source: 5 octaves each way. */
const KEY_SOURCE_RANGE_SEMITONES = 60;

/** What a mod source is doing for this voice right now (-1 to 1, or 0 to 1 for the envelope and velocity). */
function sourceValue(source: number, voice: WavetableVoice, modEnvLevel: number, wheel: number): number {
  switch (source) {
    case SOURCE_MOD_ENV:
      return modEnvLevel;
    case SOURCE_LFO1:
      return voice.lfo1Value;
    case SOURCE_LFO2:
      return voice.lfo2Value;
    case SOURCE_VELOCITY:
      return voice.velocity;
    case SOURCE_WHEEL:
      return wheel;
    case SOURCE_KEY:
      return clamp((voice.key - 60) / KEY_SOURCE_RANGE_SEMITONES, -1, 1);
    default:
      return 0;
  }
}

/**
 * Adds up the mod matrix for one voice: each slot's source times its amount goes into the sum of its
 * destination. `sums` (one entry per DEST_*) is cleared first.
 */
export function sumModMatrix(
  sums: Float64Array,
  settings: ParamSnapshot,
  voice: WavetableVoice,
  modEnvLevel: number,
  wheel: number,
): void {
  sums.fill(0);
  for (let slot = 0; slot < MOD_SLOTS; slot++) {
    const source = settings.modSource[slot] as number;
    if (source === SOURCE_NONE) continue;
    const destination = settings.modTarget[slot] as number;
    const value = sourceValue(source, voice, modEnvLevel, wheel);
    sums[destination] = (sums[destination] as number) + (settings.modAmount[slot] as number) * value;
  }
}
