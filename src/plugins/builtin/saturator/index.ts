import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './saturator.worklet.ts?worker&url';
import { SATURATOR_ID, saturatorParams } from './params';

/** Oversampled tape, tube and hard-clip saturation with a tone tilt and parallel mix. */
export default defineWorkletEffect({
  id: SATURATOR_ID,
  name: 'Saturator',
  version: 1,
  category: 'Distortion',
  description: 'Adds warmth, grit and loudness like tape, tubes or hard clipping, from subtle to crushed.',
  params: saturatorParams,
  processor,
  presets: [
    { name: 'Tape warmth', params: { mode: 'tape', drive: 6, tone: -0.15, mix: 1 } },
    { name: 'Hard clip drums', params: { mode: 'clip', drive: 12, tone: 0.1, mix: 1, output: -2 } },
    { name: 'Tube glow', params: { mode: 'tube', drive: 10, tone: 0, mix: 1 } },
    { name: 'Subtle bus saturation', params: { mode: 'tape', drive: 3, tone: 0, mix: 0.6 } },
    { name: 'Crushed fuzz', params: { mode: 'clip', drive: 30, tone: -0.4, output: -4, oversample: '4x' } },
    { name: 'Parallel tube grit', params: { mode: 'tube', drive: 22, tone: 0.2, mix: 0.35 } },
  ],
});
