import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './gate.worklet.ts?worker&url';
import { GATE_ID, gateParams } from './params';

/**
 * Noise gate. On its own it gates its own input (drum spill, noise floor); choose a track under the
 * slot's "Sidechain from" menu to open it with that track instead (a pad gated by a hi-hat).
 */
export default defineWorkletEffect({
  id: GATE_ID,
  name: 'Gate',
  version: 1,
  category: 'Dynamics',
  description: 'Noise gate with hold, range and an optional sidechain key (with listen).',
  params: gateParams,
  processor,
  sidechain: true,
  presets: [
    { name: 'Drum gate', params: { threshold: -30, range: -80, attack: 0.2, hold: 40, release: 80 } },
    { name: 'Tight', params: { threshold: -24, range: -80, attack: 0.1, hold: 10, release: 30 } },
    { name: 'Noise floor', params: { threshold: -50, range: -30, attack: 1, hold: 80, release: 250 } },
    { name: 'Keyed chop', params: { threshold: -36, range: -60, attack: 0.5, hold: 20, release: 40 } },
  ],
});
