import { defineWorkletInstrument, type ParamValue } from '@agstudio/sdk';
import { lazyUi } from '@agstudio/sdk/ui';
import processor from './wavetable.worklet.ts?worker&url';
import { WAVETABLE_ID, wavetableParams } from './params';
import { factoryBank } from './tables';

/** Mod matrix slots as `[source, destination, amount]` (slots left out are off). */
function routes(...slots: [string, string, number][]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  slots.forEach(([source, target, amount], i) => {
    out[`mod${i + 1}Source`] = source;
    out[`mod${i + 1}Target`] = target;
    out[`mod${i + 1}Amount`] = amount;
  });
  return out;
}

/**
 * Wavetable: two morphing wavetable oscillators and a full modulation section. The tables are
 * built once on the main thread (tables.ts) and handed to every kernel in `setup` (shared memory
 * when the page is cross-origin isolated, a copy otherwise).
 */
export default defineWorkletInstrument({
  id: WAVETABLE_ID,
  name: 'Wavetable',
  version: 1,
  category: 'Synths',
  description:
    'Wavetable synth: two morphing oscillators (10 tables) with unison, sub and noise, a filter, two envelopes, two tempo-syncable LFOs and a 6-slot mod matrix, for pads, leads, basses and evolving sounds.',
  params: wavetableParams,
  processor,
  // At least 4 s; longer when the amp release is (it reaches −60 dB at its time, −100 dB at 1.7×).
  tailTime: (v) => Math.max(4, 1.7 * Number(v.ampRelease)),
  ui: lazyUi(() => import('./ui').then((m) => m.WavetableUI)),
  setup(port) {
    const bank = factoryBank();
    port.send({ type: 'bank', data: bank.data, tables: bank.tables, frames: bank.frames });
  },
  presets: [
    { name: 'Init: basic saw', params: {} },
    {
      name: 'Warm supersaw pad',
      params: {
        osc2Position: 2 / 3,
        osc2Coarse: -12,
        osc2Level: 0.35,
        unison: 7,
        detune: 22,
        spread: 0.9,
        filterType: 'lp24',
        cutoff: 3200,
        resonance: 0.15,
        keyTrack: 0.4,
        envAmount: 0.15,
        modAttack: 0.8,
        modDecay: 1.5,
        modSustain: 0.3,
        ampAttack: 0.6,
        ampDecay: 1,
        ampSustain: 0.85,
        ampRelease: 1.8,
        lfo2Rate: 0.15,
        ...routes(['lfo2', 'cutoff', 0.08]),
        level: -12,
      },
    },
    {
      name: 'Glassy pluck',
      params: {
        osc1Table: 'glass',
        osc1Position: 0.7,
        osc2Position: 0,
        osc2Coarse: 12,
        osc2Level: 0.3,
        unison: 2,
        detune: 8,
        spread: 0.5,
        cutoff: 2500,
        envAmount: 0.45,
        modDecay: 0.25,
        ampAttack: 0.001,
        ampDecay: 0.5,
        ampSustain: 0,
        ampRelease: 0.4,
        level: -6,
      },
    },
    {
      name: 'Deep sub bass',
      params: {
        osc1Position: 1 / 3,
        osc1Level: 0.7,
        subLevel: 0.8,
        filterType: 'lp24',
        cutoff: 400,
        resonance: 0.1,
        keyTrack: 0.5,
        ampAttack: 0.003,
        ampDecay: 0.3,
        ampSustain: 0.9,
        ampRelease: 0.12,
        voiceMode: 'mono',
        glide: 0.04,
        level: -6,
      },
    },
    {
      name: 'Vocal formant lead',
      params: {
        osc1Table: 'vocal',
        osc1Position: 0,
        osc2Table: 'vocal',
        osc2Position: 0.5,
        osc2Coarse: 12,
        osc2Level: 0.3,
        unison: 2,
        detune: 10,
        lfo1Shape: 'triangle',
        lfo1Rate: 0.35,
        lfo1Retrigger: false,
        lfo2Shape: 'sine',
        lfo2Rate: 5.5,
        ...routes(['lfo1', 'osc1Position', 0.5], ['lfo2', 'pitch', 0.008], ['modWheel', 'osc2Position', 0.5]),
        voiceMode: 'legato',
        glide: 0.08,
        level: -7,
      },
    },
    {
      name: 'PWM strings',
      params: {
        osc1Table: 'pulse',
        osc1Position: 0.3,
        osc2Table: 'pulse',
        osc2Position: 0.3,
        osc2Fine: 7,
        osc2Level: 0.6,
        unison: 3,
        detune: 12,
        spread: 0.8,
        cutoff: 4500,
        ampAttack: 0.3,
        ampDecay: 0.5,
        ampSustain: 0.85,
        ampRelease: 1,
        lfo1Rate: 0.6,
        lfo1Retrigger: false,
        lfo2Rate: 0.45,
        lfo2Shape: 'sine',
        lfo2Retrigger: false,
        ...routes(['lfo1', 'osc1Position', 0.35], ['lfo2', 'osc2Position', 0.3]),
        level: -10,
      },
    },
    {
      name: 'Sync scream lead',
      params: {
        osc1Table: 'sync',
        osc1Position: 0.2,
        unison: 2,
        detune: 10,
        drive: 0.4,
        cutoff: 6000,
        resonance: 0.2,
        modDecay: 0.6,
        modSustain: 0.2,
        ...routes(['modEnv', 'osc1Position', 0.6], ['modWheel', 'osc1Position', 0.4]),
        voiceMode: 'legato',
        glide: 0.06,
        level: -9,
      },
    },
    {
      name: 'Wobble bass (1/8 synced LFO)',
      params: {
        osc1Position: 0.75,
        subLevel: 0.6,
        filterType: 'lp24',
        cutoff: 250,
        resonance: 0.45,
        drive: 0.3,
        keyTrack: 0,
        ampSustain: 1,
        ampRelease: 0.1,
        lfo1Sync: true,
        lfo1Length: '1/8',
        lfo1Retrigger: false,
        ...routes(['lfo1', 'cutoff', 0.45]),
        voiceMode: 'mono',
        level: -6,
      },
    },
    {
      name: 'Bell keys',
      params: {
        osc1Table: 'glass',
        osc1Position: 1,
        osc2Table: 'harmonics',
        osc2Position: 0.2,
        osc2Coarse: 24,
        osc2Level: 0.25,
        cutoff: 8000,
        keyTrack: 0.6,
        ampAttack: 0.001,
        ampDecay: 2.5,
        ampSustain: 0,
        ampRelease: 1.2,
        level: -6,
      },
    },
    {
      name: 'Evolving texture',
      params: {
        osc1Table: 'resonant',
        osc1Position: 0.2,
        osc2Table: 'formant',
        osc2Position: 0.5,
        osc2Level: 0.5,
        unison: 4,
        detune: 15,
        spread: 1,
        noiseLevel: 0.08,
        noiseTone: 0.6,
        cutoff: 5000,
        ampAttack: 1.5,
        ampSustain: 1,
        ampRelease: 3,
        lfo1Shape: 'smooth',
        lfo1Rate: 0.07,
        lfo1Retrigger: false,
        lfo2Shape: 'triangle',
        lfo2Rate: 0.11,
        lfo2Retrigger: false,
        ...routes(['lfo1', 'osc1Position', 0.6], ['lfo2', 'osc2Position', 0.5], ['lfo2', 'pan', 0.4]),
        level: -10,
      },
    },
  ],
});
