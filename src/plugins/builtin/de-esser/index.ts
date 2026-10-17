import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './de-esser.worklet.ts?worker&url';
import { DE_ESSER_ID, deEsserParams } from './params';

/**
 * Split-band de-esser (worklet kernel, zero latency): watches a band between 3 and 12 kHz and turns
 * just that band down while a harsh "s" passes, or the whole voice in Wideband mode. Listen plays
 * the watched band alone; the meter shows how much it is turning down.
 */
export default defineWorkletEffect({
  id: DE_ESSER_ID,
  name: 'De-esser',
  version: 1,
  category: 'Dynamics',
  description: 'Tames harsh “s” and “t” sounds in a voice without dulling the rest of it.',
  params: deEsserParams,
  processor,
  tap: true,
  meters: [
    {
      reading: 'gr',
      label: 'De-essing',
      kind: 'reduction',
      max: 20,
      hint: 'How much the hiss band is turned down right now. It should move on “s” sounds and rest in between',
    },
  ],
  presets: [
    {
      name: 'Gentle',
      params: { frequency: 6500, q: 1.6, threshold: -30, ratio: 3, range: 6, attack: 1, release: 60, mode: 'split' },
    },
    {
      name: 'Bright vocal',
      params: { frequency: 8500, q: 1.2, threshold: -30, ratio: 4, range: 9, attack: 0.8, release: 50, mode: 'split' },
    },
    {
      name: 'Harsh S’s',
      params: { frequency: 6500, q: 1.1, threshold: -36, ratio: 8, range: 15, attack: 0.3, release: 40, mode: 'split' },
    },
    {
      name: 'Podcast voice (wideband)',
      params: { frequency: 5500, q: 1.5, threshold: -28, ratio: 3, range: 6, attack: 1, release: 80, mode: 'wide' },
    },
    {
      name: 'Deep voice',
      params: { frequency: 5200, q: 1.4, threshold: -32, ratio: 3, range: 8, attack: 1, release: 60, mode: 'split' },
    },
    {
      name: 'Tame bright cymbals',
      params: { frequency: 9500, q: 0.9, threshold: -30, ratio: 3, range: 6, attack: 0.5, release: 50, mode: 'split' },
    },
  ],
});
