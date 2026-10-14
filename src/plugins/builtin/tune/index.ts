import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './tune.worklet.ts?worker&url';
import { TUNE_ID, tuneLatencyFrames, tuneParams } from './params';

/**
 * Scale pitch correction for vocals (or any single melody line): pulls each note to the nearest
 * note of the chosen key and scale. Its 12 ms shifter window is reported as latency.
 */
export default defineWorkletEffect({
  id: TUNE_ID,
  name: 'Tune',
  version: 1,
  category: 'Voice',
  description:
    'Pulls a singer (or any single melody) to the notes of a key and scale, from gentle correction to the robotic hard-tune effect.',
  params: tuneParams,
  processor,
  latency: (sampleRate) => tuneLatencyFrames(sampleRate) / sampleRate,
  tap: true,
  tailTime: 0.05,
  presets: [
    { name: 'Natural vocal tune (C major)', params: { key: 'C', scale: 'major', speed: 60, mix: 1 } },
    { name: 'Hard tune robot (A minor)', params: { key: 'A', scale: 'minor', speed: 0, mix: 1 } },
    { name: 'Gentle correction (chromatic)', params: { scale: 'chromatic', speed: 120, mix: 1 } },
    { name: 'Pop tune (G major)', params: { key: 'G', scale: 'major', speed: 25, mix: 1 } },
    { name: 'Minor pentatonic snap (E)', params: { key: 'E', scale: 'minor-pentatonic', speed: 5, mix: 1 } },
    { name: 'Deep voice hard tune (F minor)', params: { key: 'F', scale: 'minor', speed: 0, range: 'low' } },
  ],
});
