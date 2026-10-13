import { dbToGain, defineInstrument, p, sumSignals } from '@agstudio/sdk';
import { clickWave, CURVE_RANGE, driveCurve, driveGain, driveMakeup } from './curves.kernel';
import { MonoBass } from './mono';

/**
 * Chrome's 4× oversampling delays a WaveShaperNode by 192 frames at every sample rate (measured by
 * test/browser/mixer.test.ts). Instruments can't report latency, so voices start that much early
 * and the 808 lines up with the grid (and with a kick on the same step).
 */
const SHAPER_LATENCY_FRAMES = 192;
/** Q in dB (Web Audio low-pass) for a peak-free Butterworth response. */
const BUTTERWORTH_Q_DB = -3.0103;
/** punchTime and decay are the times by which the pitch drop and the level have done ~98% (e^-4). */
const TIME_TO_TAU = 4;

const params = {
  tune: p.int(-12, 12, 0, { label: 'Tune', unit: 'st', group: 'Pitch', hint: 'Transposes every note' }),
  glide: p.float(0, 0.6, 0.08, {
    label: 'Glide',
    unit: 's',
    group: 'Pitch',
    hint: 'Slide time when a note starts before the previous one ends (overlap notes to slide)',
  }),
  punch: p.float(0, 24, 12, {
    label: 'Punch',
    unit: 'st',
    group: 'Attack',
    hint: 'Pitch drop at the start of each hit (slides do not punch)',
  }),
  punchTime: p.float(5, 150, 30, {
    label: 'Punch time',
    unit: 'ms',
    scale: 'log',
    group: 'Attack',
    hint: 'How fast the pitch drop settles',
  }),
  click: p.float(0, 1, 0.3, {
    label: 'Click',
    unit: '%',
    group: 'Attack',
    hint: 'A very short transient at the start of each hit',
  }),
  decay: p.float(0.1, 8, 1.6, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Body',
    hint: 'How long a held note rings (it has faded by about 35 dB after this time)',
  }),
  drive: p.float(0, 1, 0.3, {
    label: 'Drive',
    unit: '%',
    group: 'Body',
    hint: 'Saturation: warm at first, harsh when pushed; tails sustain longer as you add it',
  }),
  tone: p.float(150, 8000, 4000, {
    label: 'Tone',
    unit: 'Hz',
    scale: 'log',
    group: 'Body',
    hint: 'Low-pass after the drive: lower is darker',
  }),
  // At 0 dB a full-velocity hit peaks about where the kit's kick does (-6 dBFS on a default channel).
  level: p.float(-36, 6, 0, { label: 'Level', unit: 'dB', scale: 'db', group: 'Output' }),
};

/** The click as an AudioBuffer per sample rate (buffers are not tied to a context). */
const clicks = new Map<number, AudioBuffer>();
function clickBuffer(sampleRate: number): AudioBuffer {
  let buffer = clicks.get(sampleRate);
  if (!buffer) {
    const data = clickWave(sampleRate);
    buffer = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate });
    buffer.copyToChannel(data, 0);
    clicks.set(sampleRate, buffer);
  }
  return buffer;
}

/**
 * Trap/drill 808: a sine with a pitch punch at the attack, a long exponential decay, tanh drive and
 * a low-pass tone control. Mono and legato: a note that starts while the previous one is still held
 * slides to its pitch without a new attack; any other note retriggers with punch and click.
 */
export default defineInstrument({
  id: 'agstudio.bass808',
  name: '808 Bass',
  version: 1,
  category: 'Synths',
  description: 'Sine bass with pitch punch, long decay and drive; overlapping notes glide (mono, legato).',
  params,
  presets: [
    { name: 'Classic 808', params: {} },
    { name: 'Long slide', params: { decay: 5, glide: 0.22, punch: 10, punchTime: 40, drive: 0.35 } },
    { name: 'Distorted', params: { drive: 0.75, tone: 3200, punch: 14, decay: 2.2, click: 0.45, level: -6 } },
    { name: 'Short punchy', params: { decay: 0.45, punch: 18, punchTime: 22, click: 0.6, glide: 0.05, drive: 0.4 } },
    { name: 'Sub only', params: { punch: 3, punchTime: 20, click: 0, drive: 0, tone: 300, decay: 2.5 } },
    { name: 'Drill slide', params: { decay: 3, glide: 0.12, punch: 8, punchTime: 25, drive: 0.5, tone: 2500 } },
  ],

  create(host) {
    const ac = host.audioContext;
    const P = host.params;
    // voices → drive (gain → tanh shaper → make-up) → tone → level
    const bus = new GainNode(ac);
    const pre = new GainNode(ac);
    const shaper = new WaveShaperNode(ac, { curve: driveCurve(), oversample: '4x' });
    const makeup = new GainNode(ac);
    const tone = new BiquadFilterNode(ac, { type: 'lowpass', Q: BUTTERWORTH_Q_DB });
    const out = new GainNode(ac);
    bus.connect(pre).connect(shaper).connect(makeup).connect(tone).connect(out);
    P.drive.bind(pre.gain, (d) => driveGain(d) / CURVE_RANGE);
    P.drive.bind(makeup.gain, driveMakeup);
    P.tone.bind(tone.frequency);
    P.level.bind(out.gain, dbToGain);

    const mono = new MonoBass({
      audioContext: ac,
      destination: bus,
      // The tune knob (semitones) plus the channel's pitch and MIDI pitch bend.
      tune: host.channel
        ? sumSignals(
            ac,
            P.tune.signal((st) => st * 100),
            host.channel.pitch,
          )
        : P.tune.signal((st) => st * 100),
      lead: SHAPER_LATENCY_FRAMES / ac.sampleRate,
      click: clickBuffer(ac.sampleRate),
      settings: (t) => ({
        punch: P.punch.valueAt(t),
        punchTau: P.punchTime.valueAt(t) / 1000 / TIME_TO_TAU,
        decayTau: P.decay.valueAt(t) / TIME_TO_TAU,
        click: P.click.valueAt(t),
        glide: P.glide.valueAt(t),
      }),
    });

    return {
      output: out,
      // Held notes decay on their own; after the last note-off only the short release remains.
      tailTime: 0.25,
      noteOn: (e) => mono.noteOn(e),
      noteOff: (e) => mono.noteOff(e),
      allNotesOff: (time, hard) => mono.allNotesOff(time, hard),
      dispose() {
        mono.dispose();
        for (const n of [bus, pre, shaper, makeup, tone, out]) n.disconnect();
      },
    };
  },
});
