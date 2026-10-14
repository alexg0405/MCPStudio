import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './slicer.worklet.ts?worker&url';
import { demoLoop, DEMO_RATE } from './demo.kernel';
import type { DemoMessage } from './kernel';
import { SLICER_ID, slicerParams } from './params';
import { SlicerUI } from './ui';

/**
 * Slicer (Slicex-style): chops its sample, or a built-in demo break while the slot is empty, into
 * slices at the hits or on an even grid, one slice per key from C5 (60) up.
 */
export default defineWorkletInstrument({
  id: SLICER_ID,
  name: 'Slicer',
  version: 1,
  category: 'Samplers',
  description:
    'Chops a loop or sample into slices at its hits (or on an even grid) and plays slice 1, 2, 3… on keys 60, 61, 62… (C5 up), to rearrange breaks and phrases.',
  params: slicerParams,
  processor,
  sampleSlots: ['main'],
  samplePickers: false,
  tailTime: 2,
  ui: SlicerUI,
  setup(port) {
    const msg: DemoMessage = { type: 'demo', data: demoLoop(), sampleRate: DEMO_RATE };
    port.send(msg);
  },
  presets: [
    { name: 'Chop at the hits (default)', params: {} },
    {
      name: 'Lo-fi chop (pitched down, soft)',
      params: { tune: -4, attack: 6, velocity: 0.8, sensitivity: 0.4, level: -1 },
    },
    {
      name: 'Punchy gated chops (no tails)',
      params: { playback: 'gated', release: 5, sensitivity: 0.75, minSlice: 40, level: 0 },
    },
    {
      name: 'Stutter (64 tiny grid slices)',
      params: { mode: 'grid', gridSlices: 64, playback: 'gated', release: 8 },
    },
    {
      name: 'Even 16 slices (one-bar loop)',
      params: { mode: 'grid', gridSlices: 16 },
    },
    {
      name: 'Reverse chops',
      params: { reverse: true, attack: 10, cut: false, sensitivity: 0.5 },
    },
    {
      name: 'Half-speed (an octave down)',
      params: { tune: -12, mode: 'grid', gridSlices: 8, release: 200 },
    },
  ],
});
