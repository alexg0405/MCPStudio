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
  description: 'Dips this track’s volume every time another track (say the kick) hits: the sidechain pump.',
  params: duckerParams,
  processor,
  sidechain: true,
  presets: [
    {
      name: 'Classic EDM pump',
      params: { depth: 0.85, threshold: -30, attack: 1, hold: 20, release: 220, curve: 0.4 },
    },
    {
      name: 'Tight duck for bass',
      params: { depth: 0.6, threshold: -24, attack: 0.5, hold: 10, release: 90, curve: 0 },
    },
    {
      name: 'Slow breathing pad',
      params: { depth: 1, threshold: -36, attack: 4, hold: 60, release: 500, curve: 0.7 },
    },
    {
      name: 'Subtle room for vocals',
      params: { depth: 0.35, threshold: -30, attack: 2, hold: 0, release: 150, curve: -0.3 },
    },
  ],
});
