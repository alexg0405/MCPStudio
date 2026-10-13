import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './ducker.worklet.ts?worker&url';
import { DUCKER_ID, duckerParams } from './params';

/**
 * Sidechain ducker (FL's "sidechain to this track" pump): put it on the bass or pad track and choose
 * the kick's track under the slot's "Sidechain from" menu. Without a sidechain it ducks to its own
 * input.
 */
export default defineWorkletEffect({
  id: DUCKER_ID,
  name: 'Ducker',
  version: 1,
  category: 'Dynamics',
  description: 'Ducks this track whenever the sidechain track (a kick) hits: depth, hold, release and curve.',
  params: duckerParams,
  processor,
  sidechain: true,
  presets: [
    { name: 'Pump', params: { depth: 0.85, threshold: -30, attack: 1, hold: 20, release: 220, curve: 0.4 } },
    { name: 'Tight duck', params: { depth: 0.6, threshold: -24, attack: 0.5, hold: 10, release: 90, curve: 0 } },
    { name: 'Deep breath', params: { depth: 1, threshold: -36, attack: 4, hold: 60, release: 500, curve: 0.7 } },
    { name: 'Subtle space', params: { depth: 0.35, threshold: -30, attack: 2, hold: 0, release: 150, curve: -0.3 } },
  ],
});
