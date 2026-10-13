import { dbToGain, defineEffect, p } from '@agstudio/sdk';
import { RANGE, curve, driveCompensation, type CurveKind } from './curves.kernel';

/**
 * Chrome's 4× oversampling (two up/down-sampling FIR stages) delays the WaveShaperNode's output by
 * 192 frames at every sample rate (checked by test/browser/mixer.test.ts). The dry path is delayed
 * to match, and the plugin reports it as latency.
 */
const SHAPER_LATENCY_FRAMES = 192;
/** Q in dB (Web Audio low-pass) for a peak-free Butterworth response. */
const BUTTERWORTH_Q_DB = -3.0103;

const CURVES = ['soft', 'hard', 'fold'] as const satisfies readonly CurveKind[];

const params = {
  drive: p.float(0, 36, 12, {
    label: 'Drive',
    unit: 'dB',
    group: 'Shape',
    hint: 'Gain into the shaper: more drive, more distortion',
  }),
  curve: p.enum(CURVES, 'soft', {
    label: 'Curve',
    group: 'Shape',
    labels: { soft: 'Soft clip', hard: 'Hard clip', fold: 'Wavefold' },
    hint: 'Soft: warm saturation. Hard: buzzy clipping. Wavefold: metallic, folds peaks back down',
  }),
  tone: p.float(500, 20000, 12000, {
    label: 'Tone',
    unit: 'Hz',
    scale: 'log',
    group: 'Output',
    hint: 'Low-pass after the shaper: lower is darker',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend with the clean signal (parallel distortion)',
  }),
  output: p.float(-24, 12, 0, { label: 'Output', unit: 'dB', scale: 'db', group: 'Output' }),
};

/**
 * WaveShaper distortion with 4× oversampling. The drive is a gain in front of a fixed curve, and an
 * automatic level compensation keeps a -12 dBFS signal at about the same loudness at any drive.
 */
export default defineEffect({
  id: 'agstudio.distortion',
  name: 'Distortion',
  version: 1,
  category: 'Distortion',
  description: 'Soft clip, hard clip or wavefold distortion with a tone control and dry/wet mix.',
  params,
  presets: [
    { name: 'Warm drive', params: { drive: 9, curve: 'soft', tone: 8000 } },
    { name: 'Crunch', params: { drive: 18, curve: 'hard', tone: 6000 } },
    { name: 'Fuzz', params: { drive: 32, curve: 'hard', tone: 4000, output: -3 } },
    { name: 'Wavefolder', params: { drive: 14, curve: 'fold', tone: 10000, mix: 0.8 } },
    { name: 'Parallel grit', params: { drive: 24, curve: 'soft', tone: 5000, mix: 0.35 } },
  ],

  create({ audioContext: ac, params: P }) {
    const latency = SHAPER_LATENCY_FRAMES / ac.sampleRate;
    const input = new GainNode(ac);
    const drive = new GainNode(ac);
    const shaper = new WaveShaperNode(ac, { curve: curve(P.curve.value), oversample: '4x' });
    const tone = new BiquadFilterNode(ac, { type: 'lowpass', Q: BUTTERWORTH_Q_DB });
    const level = new GainNode(ac);
    const wet = new GainNode(ac);
    const dryDelay = new DelayNode(ac, { maxDelayTime: 0.1, delayTime: latency });
    const dry = new GainNode(ac);
    const output = new GainNode(ac);
    input.connect(drive).connect(shaper).connect(tone).connect(level).connect(wet).connect(output);
    input.connect(dryDelay).connect(dry).connect(output);
    // The curve spans ±RANGE signal units over the shaper's ±1 input, so the drive scales by 1/RANGE.
    P.drive.bind(drive.gain, (db) => dbToGain(db) / RANGE);
    P.drive.bind(level.gain, (db) => driveCompensation(dbToGain(db)));
    P.tone.bind(tone.frequency);
    P.mix.bind(wet.gain);
    P.mix.bind(dry.gain, (m) => 1 - m);
    P.output.bind(output.gain, dbToGain);
    P.curve.onChange((kind) => {
      shaper.curve = curve(kind);
    });
    return {
      input,
      output,
      latency,
      dispose() {
        for (const n of [input, drive, shaper, tone, level, wet, dryDelay, dry, output]) n.disconnect();
      },
    };
  },
});
