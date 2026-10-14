import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './chorus.worklet.ts?worker&url';
import { CHORUS_ID, chorusParams } from './params';

/** Stereo chorus with up to four voices a side, free-running or synced to the song. */
export default defineWorkletEffect({
  id: CHORUS_ID,
  name: 'Chorus',
  version: 1,
  category: 'Modulation',
  description: 'Thickens and widens a sound with slightly detuned, delayed copies of it.',
  params: chorusParams,
  processor,
  tailTime: 0.05,
  presets: [
    { name: 'Classic chorus', params: { rate: 0.6, depth: 0.5, delay: 12, voices: 2, width: 0.8, mix: 0.5 } },
    { name: 'Wide chorus', params: { rate: 0.4, depth: 0.7, delay: 18, voices: 3, width: 1, mix: 0.55 } },
    { name: 'Subtle doubler', params: { rate: 0.25, depth: 0.25, delay: 22, voices: 1, width: 1, mix: 0.4 } },
    { name: 'Lush pad ensemble', params: { rate: 0.3, depth: 0.85, delay: 25, voices: 4, width: 1, mix: 0.6 } },
    {
      name: 'Synced shimmer (1/4)',
      params: { sync: '1/4', depth: 0.4, delay: 8, voices: 2, width: 0.9, mix: 0.5 },
    },
    { name: 'Metallic chorus', params: { rate: 1.5, depth: 0.4, delay: 6, voices: 2, feedback: 0.5, mix: 0.5 } },
  ],
});
