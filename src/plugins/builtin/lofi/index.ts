import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './lofi.worklet.ts?worker&url';
import { lofiLatencyFrames, LOFI_ID, lofiParams } from './params';

/**
 * Lo-fi character: bit and sample-rate reduction, wow and flutter, vinyl crackle and hiss, and a
 * tone filter. Its wobble delay line adds 8 ms of latency, which the mixer compensates.
 */
export default defineWorkletEffect({
  id: LOFI_ID,
  name: 'Lo-Fi',
  version: 1,
  category: 'Character',
  description: 'Makes a sound old and worn: vinyl crackle, tape wobble, hiss, old-sampler grit and dull speakers.',
  params: lofiParams,
  processor,
  latency: (sampleRate) => lofiLatencyFrames(sampleRate) / sampleRate,
  tailTime: 0.02,
  presets: [
    {
      name: 'Lo-fi vinyl',
      params: { bits: 14, rate: 32000, wow: 0.35, flutter: 0.1, crackle: 0.45, noise: 0.25, tone: 7000 },
    },
    { name: '8-bit console', params: { bits: 8, rate: 11025, wow: 0, flutter: 0, noise: 0, tone: 20000 } },
    { name: 'Cassette wobble', params: { bits: 16, rate: 48000, wow: 0.6, flutter: 0.45, noise: 0.35, tone: 9000 } },
    { name: 'Old radio', params: { bits: 10, rate: 16000, wow: 0.1, noise: 0.4, crackle: 0.15, tone: 3000 } },
    {
      name: 'Dusty sampler (12-bit, 26 kHz)',
      params: { bits: 12, rate: 26040, wow: 0, flutter: 0, noise: 0.05, tone: 12000 },
    },
    {
      name: 'Subtle grit',
      params: { bits: 12, rate: 36000, wow: 0.1, flutter: 0.05, noise: 0.08, tone: 14000, mix: 0.6 },
    },
    { name: 'Destroyed', params: { bits: 3, rate: 4000, wow: 0.2, noise: 0.1, tone: 5000 } },
  ],
});
