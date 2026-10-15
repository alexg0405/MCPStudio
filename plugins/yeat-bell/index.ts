/**
 * Yeat Bell: a giant tuned one-shot bell (modal partials, strike transient, sub, saturation).
 */
import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletInstrument({
  id: ID,
  name: 'Yeat Bell',
  version: 1,
  category: 'Synths',
  description: 'A massive, tuned one-shot church bell hit with a metallic strike and a sub, made for rage-style impacts.',
  params,
  processor,
  presets: [
    { name: 'Giant Yeat bell', params: { decay: 6, brightness: 0.65, strike: 0.8, sub: 0.6, drive: 0.4 } },
    { name: 'Dark cathedral bell', params: { decay: 9, brightness: 0.35, sub: 0.4 } },
    { name: 'Short rage bell', params: { decay: 1.5, strike: 0.9, sub: 0.7, drive: 0.5 } },
    { name: 'Glassy high bell', params: { brightness: 0.9, sub: 0, inharmonic: 0.15 } },
  ],
});
