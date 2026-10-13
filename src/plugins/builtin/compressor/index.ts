import { dbToGain, defineEffect, p } from '@agstudio/sdk';
import { nativeLatencyFrames, nativeMakeupGain } from './makeup.kernel';

const params = {
  threshold: p.float(-60, 0, -18, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Compression',
    hint: 'Level above which the signal is turned down',
  }),
  ratio: p.float(1, 20, 4, {
    label: 'Ratio',
    unit: 'x',
    scale: 'log',
    group: 'Compression',
    hint: 'How hard: at 4x, 4 dB over the threshold comes out as 1 dB',
  }),
  knee: p.float(0, 40, 6, {
    label: 'Knee',
    unit: 'dB',
    group: 'Compression',
    hint: 'Width of the soft transition around the threshold',
  }),
  attack: p.float(0.5, 200, 5, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast compression starts (slower lets transients through)',
  }),
  release: p.float(10, 1000, 150, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast the level recovers',
  }),
  makeup: p.float(-12, 24, 0, { label: 'Makeup', unit: 'dB', group: 'Output', hint: 'Gain after compression' }),
};

/**
 * Compressor on the native DynamicsCompressorNode. The node adds its own automatic makeup gain;
 * it is divided out (nativeMakeupGain) so below the threshold the signal passes at unity and the
 * Makeup knob is the only gain. The node looks 6 ms ahead, which is reported as latency so the
 * mixer slot's dry/wet stays phase-aligned.
 */
export default defineEffect({
  id: 'agstudio.compressor',
  name: 'Compressor',
  version: 1,
  category: 'Dynamics',
  description: 'Feed-forward compressor: threshold, ratio, knee, attack, release, makeup gain.',
  params,
  presets: [
    { name: 'Gentle glue', params: { threshold: -18, ratio: 2, knee: 10, attack: 10, release: 200, makeup: 2 } },
    { name: 'Vocal', params: { threshold: -20, ratio: 3, knee: 6, attack: 5, release: 120, makeup: 4 } },
    { name: 'Drum punch', params: { threshold: -16, ratio: 4, knee: 3, attack: 20, release: 80, makeup: 3 } },
    { name: 'Squash', params: { threshold: -35, ratio: 12, knee: 0, attack: 1, release: 60, makeup: 10 } },
    { name: 'Peak catcher', params: { threshold: -6, ratio: 20, knee: 0, attack: 0.5, release: 50, makeup: 3 } },
  ],

  create({ audioContext: ac, params: P }) {
    const comp = new DynamicsCompressorNode(ac);
    const out = new GainNode(ac);
    comp.connect(out);
    P.threshold.bind(comp.threshold);
    P.ratio.bind(comp.ratio);
    P.knee.bind(comp.knee);
    P.attack.bind(comp.attack, (ms) => ms / 1000);
    P.release.bind(comp.release, (ms) => ms / 1000);
    const gain = () => dbToGain(P.makeup.value) / nativeMakeupGain(P.threshold.value, P.knee.value, P.ratio.value);
    out.gain.value = gain();
    const update = (_: unknown, time: number) => out.gain.setTargetAtTime(gain(), time, 0.008 / 3);
    P.threshold.onChange(update);
    P.ratio.onChange(update);
    P.knee.onChange(update);
    P.makeup.onChange(update);
    return {
      input: comp,
      output: out,
      latency: nativeLatencyFrames(ac.sampleRate) / ac.sampleRate,
      dispose() {
        comp.disconnect();
        out.disconnect();
      },
    };
  },
});
