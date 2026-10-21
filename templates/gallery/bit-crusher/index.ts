/**
 * Bit Crusher: lo-fi bit depth and sample-rate reduction, from a gentle grit to a destroyed radio.
 * Guide: docs/plugin-sdk.md
 */
import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletEffect({
  id: ID,
  name: 'Bit Crusher',
  version: 1,
  category: 'Distortion',
  description: 'Lo-fi grit: fewer bits and a lower sample rate, from subtle to destroyed.',
  params,
  processor,
  presets: [
    { name: '8-bit console', params: { bits: 8, rate: 16000, mix: 1 } },
    { name: '12-bit sampler', params: { bits: 12, rate: 26000, mix: 1 } },
    { name: 'Telephone', params: { bits: 6, rate: 6000, mix: 1 } },
    { name: 'Subtle grit', params: { bits: 10, rate: 40000, mix: 0.45 } },
    { name: 'Destroyed', params: { bits: 3, rate: 2500, mix: 1 } },
  ],
});
