import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './maximizer.worklet.ts?worker&url';
import { latencyFrames, MAXIMIZER_ID, maximizerParams } from './params';

/**
 * Loudness without the squeeze, for the master: a look-ahead limiter brings the peaks to a couple of dB over the
 * ceiling, then a soft clip (2× oversampled) rounds off just those last dB. Put it before the Limiter. Its 5.3 ms
 * look-ahead is reported as latency, so the mixer lines everything up.
 */
export default defineWorkletEffect({
  id: MAXIMIZER_ID,
  name: 'Maximizer',
  version: 1,
  category: 'Dynamics',
  description:
    'Makes a loud mix louder without squashing it: a limiter plus a gentle soft clip on the peaks. Put it before the master Limiter.',
  params: maximizerParams,
  processor,
  latency: (sampleRate) => latencyFrames(sampleRate) / sampleRate,
  tap: true,
  meters: [
    {
      reading: 'gr',
      label: 'Gain reduction',
      kind: 'reduction',
      hint: 'How much the limiter stage is turning the loudest moments down right now. A few dB is normal.',
    },
    {
      reading: 'clip',
      label: 'Peak clip',
      kind: 'reduction',
      hint: 'How many dB the soft clip is taking off the very top of the peaks right now.',
    },
  ],
  presets: [
    { name: 'Loud master (+8 dB)', params: { input: 8, ceiling: -1, clip: 2, knee: 3, release: 80 } },
    { name: 'Very loud master (+12 dB)', params: { input: 12, ceiling: -1, clip: 2.5, knee: 3, release: 70 } },
    { name: 'Gentle (+4 dB, soft)', params: { input: 4, ceiling: -1, clip: 1, knee: 4, release: 120 } },
    { name: 'Punchy (short release, sharper clip)', params: { input: 9, ceiling: -1, clip: 3, knee: 2, release: 40 } },
    { name: 'Smooth and wide (long release)', params: { input: 8, ceiling: -1, clip: 1.5, knee: 5, release: 200 } },
    { name: 'Limiter only (clip off)', params: { input: 6, ceiling: -1, clip: 0, knee: 3, release: 80 } },
  ],
});
