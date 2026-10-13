import { defineEffect, p } from '@agstudio/sdk';

const TIMES = ['1/4', '1/8', '1/8d', '1/16', '1/4t', '1/8t'] as const;
type Time = (typeof TIMES)[number];

/** Length of each note value in beats (quarter notes). */
const BEATS: Record<Time, number> = { '1/4': 1, '1/8': 0.5, '1/8d': 0.75, '1/16': 0.25, '1/4t': 2 / 3, '1/8t': 1 / 3 };

/** A quarter note at 10 BPM, the slowest tempo. */
const MAX_DELAY = 6;
/** Web Audio renders in blocks of this many frames unless the context says otherwise. */
const DEFAULT_QUANTUM = 128;
/** Q (in dB, as Web Audio's low/high-pass filters take it) of a peak-free Butterworth response. */
const BUTTERWORTH_Q_DB = -3.0103;

const params = {
  time: p.enum(TIMES, '1/8', {
    label: 'Time',
    group: 'Delay',
    labels: {
      '1/4': '1/4',
      '1/8': '1/8',
      '1/8d': '1/8 dotted',
      '1/16': '1/16',
      '1/4t': '1/4 triplet',
      '1/8t': '1/8 triplet',
    },
    hint: 'Echo time, synced to the project tempo',
  }),
  feedback: p.float(0, 0.95, 0.4, {
    label: 'Feedback',
    unit: '%',
    group: 'Delay',
    hint: 'How much of each echo feeds the next one',
  }),
  pingPong: p.bool(false, { label: 'Ping-pong', group: 'Delay', hint: 'Echoes bounce between left and right' }),
  mix: p.float(0, 1, 0.3, { label: 'Mix', unit: '%', group: 'Delay' }),
  lowCut: p.float(20, 2000, 80, {
    label: 'Low cut',
    unit: 'Hz',
    scale: 'log',
    group: 'Echo tone',
    hint: 'Removes lows from the echoes (each repeat gets thinner)',
  }),
  highCut: p.float(1000, 20000, 9000, {
    label: 'High cut',
    unit: 'Hz',
    scale: 'log',
    group: 'Echo tone',
    hint: 'Removes highs from the echoes (each repeat gets darker)',
  }),
};

/**
 * Tempo-synced stereo delay with optional ping-pong and low/high cut filters inside the feedback
 * loop. Both the straight and the ping-pong network always exist; switching crossfades their inputs
 * so echoes already in flight ring out.
 *
 * Timing: the browser breaks every feedback cycle by reading one link one render quantum late, so
 * each trip around a loop is a quantum longer than its DelayNode says. The straight loop is set one
 * quantum short with a one-quantum pre-delay in front (first echo and every repeat land on time);
 * in the ping-pong loop the late link is on the left → right hop, so the right delay is one quantum
 * short. test/browser/mixer.test.ts checks the echo positions.
 */
export default defineEffect({
  id: 'agstudio.delay',
  name: 'Delay',
  version: 1,
  category: 'Delay',
  description: 'Tempo-synced echo with feedback, ping-pong and tone filters.',
  params,
  presets: [
    { name: 'Eighth echo', params: { time: '1/8', feedback: 0.35, mix: 0.3 } },
    { name: 'Dotted ping-pong', params: { time: '1/8d', feedback: 0.45, pingPong: true, mix: 0.3 } },
    { name: 'Triplet bounce', params: { time: '1/8t', feedback: 0.4, pingPong: true, mix: 0.3 } },
    { name: 'Slapback', params: { time: '1/16', feedback: 0.08, mix: 0.25, highCut: 6000 } },
    { name: 'Dub', params: { time: '1/4', feedback: 0.7, lowCut: 300, highCut: 2500, mix: 0.35 } },
  ],

  create(host) {
    const ac = host.audioContext;
    const P = host.params;
    const nodes: AudioNode[] = [];
    const node = <N extends AudioNode>(n: N): N => {
      nodes.push(n);
      return n;
    };
    const seconds = () => Math.min(MAX_DELAY, (BEATS[P.time.value] * 60) / Math.max(1, host.transport.bpm));
    const quantumSize = (ac as BaseAudioContext & { renderQuantumSize?: number }).renderQuantumSize;
    const quantum =
      (typeof quantumSize === 'number' && quantumSize > 0 ? quantumSize : DEFAULT_QUANTUM) / ac.sampleRate;
    /** A delay time shortened by the quantum its cycle adds. */
    const inLoop = () => Math.max(quantum, seconds() - quantum);

    const input = node(new GainNode(ac));
    const output = node(new GainNode(ac));
    const dry = node(new GainNode(ac));
    const wet = node(new GainNode(ac));
    // Equal-power dry/wet.
    P.mix.bind(dry.gain, (m) => Math.cos((m * Math.PI) / 2));
    P.mix.bind(wet.gain, (m) => Math.sin((m * Math.PI) / 2));
    input.connect(dry).connect(output);
    wet.connect(output);

    /** delay → low cut → high cut → (echo out, and × feedback into the next delay). */
    const line = (time: number) => {
      const delay = node(new DelayNode(ac, { maxDelayTime: MAX_DELAY, delayTime: time }));
      const lowCut = node(new BiquadFilterNode(ac, { type: 'highpass', Q: BUTTERWORTH_Q_DB }));
      const highCut = node(new BiquadFilterNode(ac, { type: 'lowpass', Q: BUTTERWORTH_Q_DB }));
      const feedback = node(new GainNode(ac));
      delay.connect(lowCut).connect(highCut).connect(feedback);
      P.lowCut.bind(lowCut.frequency);
      P.highCut.bind(highCut.frequency);
      P.feedback.bind(feedback.gain);
      return { delay, out: highCut, feedback };
    };

    // Straight (stereo) echoes.
    const straightIn = node(new GainNode(ac));
    const align = node(new DelayNode(ac, { maxDelayTime: 0.1, delayTime: quantum }));
    const straight = line(inLoop());
    input.connect(straightIn).connect(align).connect(straight.delay);
    straight.feedback.connect(straight.delay);
    straight.out.connect(wet);

    // Ping-pong: the mono sum starts on the left and every repeat crosses over.
    const pingIn = node(
      new GainNode(ac, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }),
    );
    const left = line(seconds());
    const right = line(inLoop());
    const merge = node(new ChannelMergerNode(ac, { numberOfInputs: 2 }));
    input.connect(pingIn).connect(left.delay);
    left.feedback.connect(right.delay);
    right.feedback.connect(left.delay);
    left.out.connect(merge, 0, 0);
    right.out.connect(merge, 0, 1);
    merge.connect(wet);

    const pingPong = P.pingPong.value;
    straightIn.gain.value = pingPong ? 0 : 1;
    pingIn.gain.value = pingPong ? 1 : 0;
    P.pingPong.onChange((on, time) => {
      straightIn.gain.setTargetAtTime(on ? 0 : 1, time, 0.01);
      pingIn.gain.setTargetAtTime(on ? 1 : 0, time, 0.01);
    });

    const retime = (time: number) => {
      straight.delay.delayTime.setTargetAtTime(inLoop(), time, 0.02);
      left.delay.delayTime.setTargetAtTime(seconds(), time, 0.02);
      right.delay.delayTime.setTargetAtTime(inLoop(), time, 0.02);
    };
    P.time.onChange((_, time) => retime(time));
    const offTempo = host.transport.onTempo(() => retime(ac.currentTime));

    return {
      input,
      output,
      get tailTime() {
        const fb = P.feedback.value;
        const repeats = fb > 0.001 ? Math.log(0.001) / Math.log(fb) : 0;
        return Math.min(30, (repeats + 1) * seconds());
      },
      dispose() {
        offTempo();
        for (const n of nodes) n.disconnect();
      },
    };
  },
});
