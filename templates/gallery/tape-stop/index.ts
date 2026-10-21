/**
 * Tape Stop: the sound slows down to a halt like a tape machine switched off, then spins back up.
 * Turn Stop on at the end of a bar (or automate it) for the classic turntable-brake drop.
 * Guide: docs/plugin-sdk.md
 */
import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletEffect({
  id: ID,
  name: 'Tape Stop',
  version: 1,
  category: 'Creative',
  description: 'Slows the sound to a stop like a tape machine switched off, and spins it back up. Automate Stop for drops.',
  params,
  processor,
  presets: [
    { name: 'Quick brake', params: { slowDown: 0.4, spinUp: 0.15 } },
    { name: 'Slow wind-down', params: { slowDown: 2.5, spinUp: 0.8 } },
    { name: 'Vinyl stop', params: { slowDown: 0.9, spinUp: 0.35 } },
  ],
});
