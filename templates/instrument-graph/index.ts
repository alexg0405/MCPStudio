/**
 * __PLUGIN_NAME__: an instrument built from native Web Audio nodes.
 * Edit while `npm run dev` runs: it hot-reloads and keeps its knob settings.
 * Guide: docs/plugin-sdk.md
 */
import { dbToGain, defineInstrument, GraphVoices, mtof, p } from '@agstudio/sdk';

export default defineInstrument({
  id: '__PLUGIN_ID__',
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'Synths',
  params: {
    wave: p.enum(['sine', 'triangle', 'sawtooth', 'square'], 'triangle', { label: 'Wave' }),
    attack: p.float(0.001, 2, 0.005, { label: 'Attack', unit: 's', scale: 'log' }),
    release: p.float(0.01, 4, 0.3, { label: 'Release', unit: 's', scale: 'log' }),
    level: p.float(-36, 6, -6, { label: 'Level', unit: 'dB', scale: 'db' }),
  },

  create({ audioContext: ac, params }) {
    const out = new GainNode(ac);
    params.level.bind(out.gain, dbToGain);
    const voices = new GraphVoices(ac, out, { max: 16 });

    return {
      output: out,

      noteOn({ time, key, velocity, noteId }) {
        const t = Math.max(time, ac.currentTime);
        const osc = new OscillatorNode(ac, { type: params.wave.value, frequency: mtof(key) });
        const vca = new GainNode(ac, { gain: 0 });
        osc.connect(vca);
        vca.gain.setValueAtTime(0, t);
        vca.gain.linearRampToValueAtTime(velocity, t + params.attack.value);
        osc.start(t);
        voices.add(noteId, {
          start: t,
          sources: [osc],
          out: vca,
          release: (rt) => {
            vca.gain.cancelAndHoldAtTime(rt);
            vca.gain.setTargetAtTime(0, rt, params.release.value / 5);
            return rt + params.release.value;
          },
        });
      },

      noteOff: ({ noteId, time }) => voices.release(noteId, time),
      allNotesOff: (time, hard) => voices.releaseAll(time, hard),
      dispose: () => {
        voices.disposeAll();
        out.disconnect();
      },
    };
  },
});
