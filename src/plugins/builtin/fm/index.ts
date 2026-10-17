import { defineWorkletInstrument, FM_ALGORITHMS, type ParamValue } from '@agstudio/sdk';
import { lazyUi } from '@agstudio/sdk/ui';
import processor from './fm.worklet.ts?worker&url';
import { FM_ID, fmParams, opParam } from './params';

interface Op {
  ratio?: number;
  fine?: number;
  level?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  velocity?: number;
}

/** Preset params from per-operator settings (operators 1–4) and global ones. */
function patch(ops: Record<number, Op>, global: Record<string, ParamValue> = {}): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...global };
  for (const [n, op] of Object.entries(ops)) {
    const id = opParam(Number(n));
    for (const [k, v] of Object.entries(op)) if (v !== undefined) out[id[k as keyof Op]] = v;
  }
  return out;
}

/**
 * FM: a four-operator FM synth in the spirit of Yamaha's DX21/TX81Z (the same eight algorithms),
 * for electric pianos, bells, basses, brass and organs. Worklet kernel: ./kernel.ts.
 */
export default defineWorkletInstrument({
  id: FM_ID,
  name: 'FM',
  version: 1,
  category: 'Synths',
  description:
    'Four-operator FM synth (8 classic algorithms, feedback, an envelope per operator) for electric pianos, bells, basses, brass and organs.',
  params: fmParams,
  processor,
  // At least 4 s; longer when a carrier's release is (it reaches −60 dB at its time, −100 dB at 1.7×).
  tailTime: (v) => {
    const algorithm = FM_ALGORITHMS[Number(v.algorithm) - 1] ?? FM_ALGORITHMS[0];
    let release = 0;
    for (const c of algorithm?.carriers ?? [0]) release = Math.max(release, Number(v[opParam(c + 1).release]));
    return Math.max(4, 1.7 * release);
  },
  ui: lazyUi(() => import('./ui').then((m) => m.FmUI)),
  presets: [
    { name: 'Init: simple two-operator tone', params: {} },
    {
      name: 'Electric piano (DX-style tine)',
      params: patch(
        {
          1: { ratio: 1, level: 0.75, attack: 0.002, decay: 3, sustain: 0.15, release: 0.5, velocity: 0.7 },
          2: { ratio: 14, level: 0.32, attack: 0.001, decay: 0.25, sustain: 0, release: 0.2, velocity: 0.9 },
          3: { ratio: 1, level: 0.7, attack: 0.002, decay: 2.5, sustain: 0.2, release: 0.5, velocity: 0.6 },
          4: { ratio: 1, level: 0.5, attack: 0.002, decay: 1.5, sustain: 0.15, release: 0.4, velocity: 0.6 },
        },
        { algorithm: '5', feedback: 0.1, level: -10 },
      ),
    },
    {
      name: 'Glassy FM bell',
      params: patch(
        {
          1: { ratio: 1, level: 0.7, attack: 0.001, decay: 4, sustain: 0, release: 2.5, velocity: 0.5 },
          2: { ratio: 3, fine: 0.5, level: 0.55, attack: 0.001, decay: 3, sustain: 0, release: 2, velocity: 0.6 },
          3: { ratio: 2, fine: 0.41, level: 0.45, attack: 0.001, decay: 2.5, sustain: 0, release: 2, velocity: 0.4 },
          4: { ratio: 5, fine: 0.17, level: 0.4, attack: 0.001, decay: 1.5, sustain: 0, release: 1.5, velocity: 0.6 },
        },
        { algorithm: '5', level: -10 },
      ),
    },
    {
      name: 'Slap bass',
      params: patch(
        {
          1: { ratio: 1, level: 0.85, attack: 0.001, decay: 0.8, sustain: 0.4, release: 0.12, velocity: 0.6 },
          2: { ratio: 1, level: 0.55, attack: 0.001, decay: 0.15, sustain: 0.2, release: 0.1, velocity: 0.8 },
          3: { ratio: 3, level: 0.3, attack: 0.001, decay: 0.08, sustain: 0, release: 0.1, velocity: 0.8 },
        },
        { algorithm: '1', feedback: 0.2, cutoff: 3000, level: -7 },
      ),
    },
    {
      name: 'Brass stab',
      params: patch(
        {
          1: { ratio: 1, level: 0.8, attack: 0.03, decay: 0.5, sustain: 0.8, release: 0.2, velocity: 0.5 },
          2: { ratio: 1, level: 0.6, attack: 0.06, decay: 0.4, sustain: 0.6, release: 0.2, velocity: 0.7 },
          3: { ratio: 1, level: 0.3, attack: 0.05, decay: 0.5, sustain: 0.5, release: 0.2, velocity: 0.5 },
        },
        { algorithm: '1', feedback: 0.35, vibratoDepth: 8, cutoff: 6000, level: -9 },
      ),
    },
    {
      name: 'Drawbar organ (additive)',
      params: patch(
        {
          1: { ratio: 1, level: 0.75, attack: 0.004, decay: 10, sustain: 1, release: 0.08, velocity: 0 },
          2: { ratio: 2, level: 0.55, attack: 0.004, decay: 10, sustain: 1, release: 0.08, velocity: 0 },
          3: { ratio: 3, level: 0.4, attack: 0.004, decay: 10, sustain: 1, release: 0.08, velocity: 0 },
          4: { ratio: 4, level: 0.35, attack: 0.004, decay: 10, sustain: 1, release: 0.08, velocity: 0 },
        },
        { algorithm: '8', vibratoDepth: 6, vibratoRate: 6.5, wheel: 'vibrato', level: -10 },
      ),
    },
    {
      name: 'Marimba',
      params: patch(
        {
          1: { ratio: 1, level: 0.8, attack: 0.001, decay: 0.6, sustain: 0, release: 0.3, velocity: 0.6 },
          2: { ratio: 4, level: 0.4, attack: 0.001, decay: 0.08, sustain: 0, release: 0.1, velocity: 0.8 },
          3: { ratio: 3, level: 0.25, attack: 0.001, decay: 0.3, sustain: 0, release: 0.2, velocity: 0.5 },
          4: { ratio: 10, level: 0.2, attack: 0.001, decay: 0.05, sustain: 0, release: 0.05, velocity: 0.8 },
        },
        { algorithm: '5', level: -8 },
      ),
    },
    {
      name: 'Metallic hit (feedback)',
      params: patch(
        {
          1: { ratio: 1, level: 0.6, attack: 0.001, decay: 0.9, sustain: 0, release: 0.6 },
          2: { ratio: 2, fine: 0.37, level: 0.5, attack: 0.001, decay: 0.7, sustain: 0, release: 0.5 },
          3: { ratio: 3, fine: 0.13, level: 0.45, attack: 0.001, decay: 0.5, sustain: 0, release: 0.4 },
          4: { ratio: 7, fine: 0.33, level: 0.6, attack: 0.001, decay: 0.4, sustain: 0, release: 0.3 },
        },
        { algorithm: '6', feedback: 0.6, level: -10 },
      ),
    },
  ],
});
