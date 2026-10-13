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
  description: 'Silences a track between its hits (or whenever another track is quiet, with a sidechain).',
  params: gateParams,
  processor,
  sidechain: true,
  presets: [
    {
      name: 'Clean up drum spill',
      params: { threshold: -30, range: -80, attack: 0.2, hold: 40, release: 80 },
    },
    { name: 'Tight gate for short hits', params: { threshold: -24, range: -80, attack: 0.1, hold: 10, release: 30 } },
    { name: 'Hush the noise floor', params: { threshold: -50, range: -30, attack: 1, hold: 80, release: 250 } },
    {
      name: 'Rhythmic chop (set Sidechain from)',
      params: { threshold: -36, range: -60, attack: 0.5, hold: 20, release: 40 },
    },
  ],
});
