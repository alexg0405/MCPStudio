import { dbToGain, defineInstrument, GraphVoices, mtof, OrderedMix, p } from '@agstudio/sdk';

const WAVES = ['sine', 'triangle', 'sawtooth', 'square'] as const;
const waveLabels = { sine: 'Sine', triangle: 'Triangle', sawtooth: 'Saw', square: 'Square' };

const shape = (def: (typeof WAVES)[number], group: string) =>
  p.enum(WAVES, def, { label: 'Shape', group, labels: waveLabels });
const coarse = (def: number, group: string) => p.int(-24, 24, def, { label: 'Coarse', unit: 'st', group });
const fine = (def: number, group: string) => p.float(-100, 100, def, { label: 'Fine', unit: 'ct', group });
const level = (def: number, group: string) => p.float(0, 1, def, { label: 'Level', unit: '%', group });

const params = {
  osc1Wave: shape('sawtooth', 'Osc 1'),
  osc1Coarse: coarse(0, 'Osc 1'),
  osc1Fine: fine(0, 'Osc 1'),
  osc1Level: level(0.8, 'Osc 1'),
  osc2Wave: shape('sawtooth', 'Osc 2'),
  osc2Coarse: coarse(0, 'Osc 2'),
  osc2Fine: fine(7, 'Osc 2'),
  osc2Level: level(0.6, 'Osc 2'),
  osc3Wave: shape('square', 'Osc 3'),
  osc3Coarse: coarse(-12, 'Osc 3'),
  osc3Fine: fine(0, 'Osc 3'),
  osc3Level: level(0.4, 'Osc 3'),
  attack: p.float(0.001, 4, 0.005, { label: 'Attack', unit: 's', scale: 'log', group: 'Amp envelope' }),
  decay: p.float(0.005, 6, 0.3, { label: 'Decay', unit: 's', scale: 'log', group: 'Amp envelope' }),
  sustain: p.float(0, 1, 0.7, { label: 'Sustain', unit: '%', group: 'Amp envelope' }),
  release: p.float(0.005, 6, 0.2, { label: 'Release', unit: 's', scale: 'log', group: 'Amp envelope' }),
  cutoff: p.float(30, 18000, 4000, { label: 'Cutoff', unit: 'Hz', scale: 'log', group: 'Filter' }),
  resonance: p.float(0.1, 18, 1, { label: 'Resonance', scale: 'log', group: 'Filter' }),
  filterEnv: p.float(0, 6, 1.5, {
    label: 'Env amount',
    unit: 'x',
    group: 'Filter',
    hint: 'Octaves the filter opens on each note',
  }),
  filterDecay: p.float(0.01, 4, 0.35, { label: 'Env decay', unit: 's', scale: 'log', group: 'Filter' }),
  level: p.float(-36, 6, -9, { label: 'Level', unit: 'dB', scale: 'db', group: 'Output' }),
} as const;

type OscN = 1 | 2 | 3;

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
  params,
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
    const ac = host.audioContext;
    const P = host.params;
    const out = new GainNode(ac);
    P.level.bind(out.gain, dbToGain);
    const voices = new GraphVoices(ac, out, { max: 16 });

    // One smoothed control source per param, shared by every voice.
    const level = (n: OscN) => P[`osc${n}Level`].signal();
    const coarse = (n: OscN) => P[`osc${n}Coarse`].signal((v) => v * 100);
    const fine = (n: OscN) => P[`osc${n}Fine`].signal();
    const signals = {
      level: [level(1), level(2), level(3)],
      coarse: [coarse(1), coarse(2), coarse(3)],
      fine: [fine(1), fine(2), fine(3)],
      cutoff: P.cutoff.signal(),
      q: P.resonance.signal(),
      envAmount: P.filterEnv.signal((oct) => oct * 1200),
    };

    return {
      output: out,
      get tailTime() {
        return Math.max(1, P.release.value);
      },

      noteOn({ time, key, velocity, noteId, fine }) {
        const t = Math.max(time, ac.currentTime);
        const freq = mtof(key);
        const sum = new GainNode(ac, { gain: 1 / 2 });
        const filter = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 0, Q: 0 });
        const vca = new GainNode(ac, { gain: 0 });
        sum.connect(filter).connect(vca);
        // The three oscillators add up in a fixed order, so an offline render repeats bit for bit.
        const oscillatorMix = new OrderedMix(ac, sum);
        const cleanup: Array<() => void> = [
          () => oscillatorMix.dispose(),
          signals.cutoff.connect(filter.frequency),
          signals.q.connect(filter.Q),
        ];
        const sources: AudioScheduledSourceNode[] = [];
        const nodes: AudioNode[] = [sum, filter];

        for (const n of [1, 2, 3] as const) {
          const o = new OscillatorNode(ac, { type: P[`osc${n}Wave`].valueAt(t), frequency: freq, detune: fine ?? 0 });
          const g = new GainNode(ac, { gain: 0 });
          o.connect(g);
          cleanup.push(oscillatorMix.attach(g));
          cleanup.push(signals.level[n - 1]!.connect(g.gain));
          cleanup.push(signals.coarse[n - 1]!.connect(o.detune));
          cleanup.push(signals.fine[n - 1]!.connect(o.detune));
          if (host.channel) cleanup.push(host.channel.pitch.connect(o.detune));
          o.start(t);
          sources.push(o);
          nodes.push(g);
        }

        // Filter envelope: 0→1→0 control signal scaled to cents on the filter's detune.
        const env = new ConstantSourceNode(ac, { offset: 0 });
        const envDepth = new GainNode(ac, { gain: 0 });
        env.connect(envDepth).connect(filter.detune);
        cleanup.push(signals.envAmount.connect(envDepth.gain));
        env.offset.setValueAtTime(0, t);
        env.offset.linearRampToValueAtTime(1, t + 0.003);
        env.offset.setTargetAtTime(0, t + 0.003, P.filterDecay.valueAt(t) / 3);
        env.start(t);
        sources.push(env);
        nodes.push(envDepth);

        // Amp ADSR.
        const a = P.attack.valueAt(t);
        const peak = velocity;
        vca.gain.setValueAtTime(0, t);
        vca.gain.linearRampToValueAtTime(peak, t + a);
        vca.gain.setTargetAtTime(peak * P.sustain.valueAt(t), t + a, P.decay.valueAt(t) / 4);

        voices.add(noteId, {
          start: t,
          sources,
          out: vca,
          nodes,
          cleanup,
          release: (rt) => {
            const r = P.release.valueAt(rt);
            vca.gain.cancelAndHoldAtTime(rt);
            vca.gain.setTargetAtTime(0, rt, r / 5);
            return rt + r;
          },
        });
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
