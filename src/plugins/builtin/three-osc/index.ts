import { dbToGain, defineInstrument, GraphVoices } from '@agstudio/sdk';
import { threeOscParams } from './params';
import { buildVoice, createSharedSignals } from './voice';

/** How many notes can sound at once (the oldest is stolen without a click). */
const MAX_VOICES = 16;

/**
 * Three-oscillator subtractive synth in the spirit of FL's 3xOsc, built from native nodes.
 * Every knob is live: shared ParamSignals feed all sounding voices.
 */
export default defineInstrument({
  id: 'agstudio.3xosc',
  name: '3xOsc',
  version: 1,
  category: 'Synths',
  description: 'Three oscillators into a resonant low-pass filter with amp and filter envelopes.',
  params: threeOscParams,
  presets: [
    { name: 'Init saw', params: {} },
    {
      name: 'Soft pad',
      params: { attack: 0.6, decay: 1.2, sustain: 0.8, release: 1.5, cutoff: 1800, filterEnv: 0.6, osc3Level: 0.2 },
    },
    {
      name: 'Pluck bass',
      params: {
        osc1Coarse: -12,
        osc2Coarse: -12,
        attack: 0.002,
        decay: 0.25,
        sustain: 0.1,
        cutoff: 500,
        filterEnv: 3,
        filterDecay: 0.18,
      },
    },
  ],

  create(host) {
    const out = new GainNode(host.audioContext);
    host.params.level.bind(out.gain, dbToGain);
    const voices = new GraphVoices(host.audioContext, out, { max: MAX_VOICES });
    const signals = createSharedSignals(host.params);

    return {
      output: out,
      get tailTime() {
        return Math.max(1, host.params.release.value);
      },

      noteOn(note) {
        voices.add(note.noteId, buildVoice(host, signals, note));
      },

      noteOff({ noteId, time }) {
        voices.release(noteId, time);
      },

      allNotesOff(time, hard) {
        voices.releaseAll(time, hard);
      },

      dispose() {
        voices.disposeAll();
        out.disconnect();
      },
    };
  },
});
