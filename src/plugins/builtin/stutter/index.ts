import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './stutter.worklet.ts?worker&url';
import { STUTTER_ID, stutterParams } from './params';

/**
 * Tempo-synced performance effects: rhythmic gates, beat repeat and tape stop, all locked to the
 * song position (they only act while the song plays). Automate Beat repeat and Tape stop.
 */
export default defineWorkletEffect({
  id: STUTTER_ID,
  name: 'Stutter',
  version: 1,
  category: 'Rhythm',
  description:
    'Chops a sound in time with the song (gates), loops a slice of it (beat repeat) or slows it to a halt (tape stop).',
  params: stutterParams,
  processor,
  tailTime: 0.05,
  presets: [
    { name: '1/8 gate', params: { gate: '1/8', depth: 1, smooth: 3 } },
    { name: 'Trance gate 1/16', params: { gate: 'trance', depth: 1, smooth: 2 } },
    { name: 'Offbeat chop', params: { gate: 'offbeat', depth: 0.9, smooth: 4 } },
    { name: 'Beat repeat 1/8', params: { gate: 'off', repeat: '1/8' } },
    { name: 'Stutter roll 1/16', params: { gate: 'off', repeat: '1/16' } },
    { name: 'Tape stop (1 beat)', params: { gate: 'off', stop: true, stopTime: 1 } },
    { name: 'Half-time chop', params: { gate: 'half', depth: 1, smooth: 8 } },
    { name: 'Soft triplet pulse', params: { gate: 'triplet', depth: 0.7, smooth: 15 } },
  ],
});
