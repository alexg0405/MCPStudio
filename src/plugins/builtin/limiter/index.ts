import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './limiter.worklet.ts?worker&url';
import { latencyFrames, LIMITER_ID, limiterParams } from './params';

/**
 * Look-ahead brickwall limiter for the master (or any bus): nothing gets past the ceiling, true
 * peaks included. Its 5.3 ms look-ahead is reported as latency, so the mixer lines everything up.
 */
export default defineWorkletEffect({
  id: LIMITER_ID,
  name: 'Limiter',
  version: 1,
  category: 'Dynamics',
  description: 'Makes a mix louder and stops any peak from going over the ceiling (put it last on the master).',
  params: limiterParams,
  processor,
  latency: (sampleRate) => latencyFrames(sampleRate) / sampleRate,
  tap: true,
  meters: [
    {
      reading: 'gr',
      label: 'Gain reduction',
      kind: 'reduction',
      hint: 'How much the limiter is turning the loudest moments down right now. A few dB is normal; a lot sounds squashed.',
    },
  ],
  presets: [
    { name: 'Brickwall master −1 dB', params: { input: 0, ceiling: -1, release: 80, truePeak: true } },
    { name: 'Loud master (+6 dB)', params: { input: 6, ceiling: -1, release: 60, truePeak: true } },
    { name: 'Transparent safety −0.3 dB', params: { input: 0, ceiling: -0.3, release: 200, truePeak: true } },
    { name: 'Streaming −1 dBTP, +3 dB', params: { input: 3, ceiling: -1, release: 100, truePeak: true } },
    { name: 'Drum bus smash', params: { input: 10, ceiling: -3, release: 25, truePeak: false } },
    { name: 'Gentle peak catcher', params: { input: 2, ceiling: -2, release: 300, truePeak: true } },
  ],
});
