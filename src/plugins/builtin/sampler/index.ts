import { defineInstrument, dbToGain, GraphVoices, p } from '@agstudio/sdk';

/** Velocity tone's cutoff at full velocity. */
const TOP_HZ = 20000;
/** Q in dB (Web Audio low-pass) for a peak-free Butterworth response. */
const BUTTERWORTH_Q_DB = -3.0103;

/** A copy of the buffer played backwards (cached per buffer). */
function reversed(ac: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const out = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0, j = src.length - 1; i < src.length; i++, j--) dst[i] = src[j] as number;
  }
  void ac;
  return out;
}

/**
 * FL-style channel sampler. By default notes play the whole sample (like FL with the volume
 * envelope off); enable the envelope to shape notes with ADSR. Pitch follows the key relative to
 * the channel's root key.
 */
export default defineInstrument({
  id: 'agstudio.sampler',
  name: 'Sampler',
  version: 1,
  category: 'Samplers',
  description: 'Plays a sample, pitched by key relative to the channel root note.',
  sampleSlots: ['main'],
  params: {
    gain: p.float(-24, 12, 0, { label: 'Gain', unit: 'dB', scale: 'db', group: 'Sample' }),
    tune: p.int(-24, 24, 0, { label: 'Tune', unit: 'st', group: 'Sample' }),
    fine: p.float(-100, 100, 0, { label: 'Fine', unit: 'ct', group: 'Sample' }),
    start: p.float(0, 0.99, 0, {
      label: 'Start',
      unit: '%',
      group: 'Sample',
      hint: 'Start playback part-way into the sample',
    }),
    reverse: p.bool(false, { label: 'Reverse', group: 'Sample' }),
    cut: p.bool(false, { label: 'Cut itself', group: 'Sample', hint: 'A new note stops the previous one (open hats)' }),
    // Added in v3; 0 (the default) plays exactly as before.
    velTone: p.float(0, 1, 0, {
      label: 'Velocity tone',
      unit: '%',
      group: 'Sample',
      hint: 'Soft notes sound darker as well as quieter, like a drum hit softly (0% = only quieter). Makes rolls and ghost notes sound natural.',
    }),
    envelope: p.bool(false, {
      label: 'Envelope',
      group: 'Envelope',
      hint: 'Off: every note plays the whole sample. On: attack/decay/sustain/release shape each note.',
    }),
    attack: p.float(0.001, 2, 0.002, { label: 'Attack', unit: 's', scale: 'log', group: 'Envelope' }),
    decay: p.float(0.005, 5, 0.3, { label: 'Decay', unit: 's', scale: 'log', group: 'Envelope' }),
    sustain: p.float(0, 1, 1, { label: 'Sustain', unit: '%', group: 'Envelope' }),
    release: p.float(0.005, 5, 0.12, { label: 'Release', unit: 's', scale: 'log', group: 'Envelope' }),
  },

  create(host) {
    const ac = host.audioContext;
    const { params } = host;
    const out = new GainNode(ac);
    params.gain.bind(out.gain, dbToGain);
    const voices = new GraphVoices(ac, out, { max: 32 });

    let buffer = host.samples.get('main');
    let backwards: AudioBuffer | null = null;
    const setBuffer = (b: AudioBuffer | null) => {
      buffer = b;
      backwards = null;
    };
    if (!buffer) void host.samples.load('main').then(setBuffer);
    const unwatch = host.samples.onChange('main', setBuffer);
    const current = (reverse: boolean) => {
      if (!buffer) return null;
      if (!reverse) return buffer;
      backwards ??= reversed(ac, buffer);
      return backwards;
    };

    return {
      output: out,
      tailTime: 0.2,

      noteOn({ time, key, velocity, noteId, pan, fine }) {
        const t = Math.max(time, ac.currentTime);
        const buf = current(params.reverse.valueAt(t));
        if (!buf) return;
        if (params.cut.valueAt(t)) voices.cutOthers(t);
        const root = host.channel?.rootKey ?? 60;
        const rate = Math.pow(2, (key - root + params.tune.valueAt(t) + params.fine.valueAt(t) / 100) / 12);
        const src = new AudioBufferSourceNode(ac, { buffer: buf, playbackRate: rate, detune: fine ?? 0 });
        const cleanup = host.channel ? [host.channel.pitch.connect(src.detune)] : [];
        const speed = rate * Math.pow(2, ((fine ?? 0) + (host.channel?.pitchAt(t) ?? 0)) / 1200);
        const vca = new GainNode(ac, { gain: 0 });
        const extra: AudioNode[] = [];
        // Velocity tone: a low-pass that closes as the velocity drops, 20 kHz × 2^(−tone·(1−vel)·6)
        // (at 50 %, a hit at velocity 0.5 is cut above ~7 kHz). Off at 0: the graph is unchanged.
        const tone = params.velTone.valueAt(t);
        if (tone > 0 && velocity < 1) {
          const cutoff = TOP_HZ * Math.pow(2, -tone * (1 - Math.max(0, velocity)) * 6);
          const lp = new BiquadFilterNode(ac, {
            type: 'lowpass',
            frequency: Math.min(cutoff, ac.sampleRate * 0.45),
            Q: BUTTERWORTH_Q_DB,
          });
          src.connect(lp).connect(vca);
          extra.push(lp);
        } else src.connect(vca);
        let last: AudioNode = vca;
        if (pan) {
          const panner = new StereoPannerNode(ac, { pan });
          vca.connect(panner);
          extra.push(vca);
          last = panner;
        }
        const offset = params.start.valueAt(t) * buf.duration;
        const env = params.envelope.valueAt(t);
        vca.gain.setValueAtTime(0, t);
        if (env) {
          const a = params.attack.valueAt(t);
          vca.gain.linearRampToValueAtTime(velocity, t + a);
          vca.gain.setTargetAtTime(velocity * params.sustain.valueAt(t), t + a, params.decay.valueAt(t) / 4);
        } else {
          vca.gain.linearRampToValueAtTime(velocity, t + 0.001);
        }
        src.start(t, offset);
        const natural = t + (buf.duration - offset) / speed;
        voices.add(noteId, {
          start: t,
          sources: [src],
          out: last,
          nodes: extra,
          cleanup,
          end: natural,
          release: env
            ? (rt) => {
                const r = params.release.valueAt(rt);
                vca.gain.cancelAndHoldAtTime(rt);
                vca.gain.setTargetAtTime(0, rt, r / 5);
                return Math.min(natural, rt + r);
              }
            : () => null,
        });
      },

      noteOff({ noteId, time }) {
        voices.release(noteId, time);
      },

      allNotesOff(time, hard) {
        voices.releaseAll(time, hard);
      },

      dispose() {
        unwatch();
        voices.disposeAll();
        out.disconnect();
      },
    };
  },
});
