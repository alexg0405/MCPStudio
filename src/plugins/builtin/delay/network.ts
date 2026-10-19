import type { PluginHost } from '@agstudio/sdk';
import { BEATS, type delayParams } from './params';

export type DelayHost = PluginHost<typeof delayParams, undefined>;

/** A quarter note at 10 BPM, the slowest tempo (seconds). */
const MAX_DELAY_SEC = 6;
/** Web Audio renders in blocks of this many frames unless the context says otherwise. */
const DEFAULT_QUANTUM = 128;
/** Q (in dB, as Web Audio's low/high-pass filters take it) of a peak-free Butterworth response. */
const BUTTERWORTH_Q_DB = -3.0103;
/** The longest alignment delay in front of the straight loop (seconds): one quantum is far less. */
const MAX_ALIGN_SEC = 0.1;
/** Time constants of the switch between straight and ping-pong, and of a delay-time change (seconds). */
const MODE_SWITCH_TIME_CONSTANT_SEC = 0.01;
const RETIME_TIME_CONSTANT_SEC = 0.02;

/** One echo path: its delay, the filtered echo it outputs and the gain that feeds it back into the loop. */
interface EchoLine {
  delay: DelayNode;
  /** The echo as heard (after the tone filters). */
  out: BiquadFilterNode;
  feedback: GainNode;
}

/** The delay times of the two networks, which depend on the tempo and on what the browser adds to every loop. */
export interface DelayTiming {
  /** The echo time at a tempo (default: now), seconds. */
  seconds(bpm?: number): number;
  /** The same shortened by the quantum a feedback cycle adds. */
  inLoop(bpm?: number): number;
  /** One render quantum, seconds. */
  quantum: number;
}

/** The echo times for the host's tempo and render quantum (see the note on timing in index.ts). */
export function createTiming(host: DelayHost): DelayTiming {
  const ac = host.audioContext;
  const seconds = (bpm = host.transport.bpm) =>
    Math.min(MAX_DELAY_SEC, (BEATS[host.params.time.value] * 60) / Math.max(1, bpm));
  const quantumSize = (ac as BaseAudioContext & { renderQuantumSize?: number }).renderQuantumSize;
  const quantumFrames = typeof quantumSize === 'number' && quantumSize > 0 ? quantumSize : DEFAULT_QUANTUM;
  const quantum = quantumFrames / ac.sampleRate;
  return { seconds, inLoop: (bpm) => Math.max(quantum, seconds(bpm) - quantum), quantum };
}

/** What the Delay's main file keeps of the network. */
export interface DelayNetwork {
  input: GainNode;
  output: GainNode;
  /** Moves every delay to the echo time of `bpm` (or the current tempo), easing from `time`. */
  retime(time: number, bpm?: number): void;
  /** Disconnects every node. */
  dispose(): void;
}

/**
 * Both echo networks, always built: straight (stereo) and ping-pong, each with the low and high cut inside its
 * feedback loop, plus the equal-power dry/wet mix. `P.pingPong` crossfades their inputs.
 */
export function buildNetwork(host: DelayHost, timing: DelayTiming): DelayNetwork {
  const ac = host.audioContext;
  const params = host.params;
  const nodes: AudioNode[] = [];
  const node = <N extends AudioNode>(n: N): N => {
    nodes.push(n);
    return n;
  };

  const input = node(new GainNode(ac));
  const output = node(new GainNode(ac));
  const dry = node(new GainNode(ac));
  const wet = node(new GainNode(ac));
  // Equal-power dry/wet.
  params.mix.bind(dry.gain, (mix) => Math.cos((mix * Math.PI) / 2));
  params.mix.bind(wet.gain, (mix) => Math.sin((mix * Math.PI) / 2));
  input.connect(dry).connect(output);
  wet.connect(output);

  /** delay → low cut → high cut → (echo out, and × feedback into the next delay). */
  const echoLine = (delayTime: number): EchoLine => {
    const delay = node(new DelayNode(ac, { maxDelayTime: MAX_DELAY_SEC, delayTime }));
    const lowCut = node(new BiquadFilterNode(ac, { type: 'highpass', Q: BUTTERWORTH_Q_DB }));
    const highCut = node(new BiquadFilterNode(ac, { type: 'lowpass', Q: BUTTERWORTH_Q_DB }));
    const feedback = node(new GainNode(ac));
    delay.connect(lowCut).connect(highCut).connect(feedback);
    params.lowCut.bind(lowCut.frequency);
    params.highCut.bind(highCut.frequency);
    params.feedback.bind(feedback.gain);
    return { delay, out: highCut, feedback };
  };

  // Straight (stereo) echoes.
  const straightIn = node(new GainNode(ac));
  const align = node(new DelayNode(ac, { maxDelayTime: MAX_ALIGN_SEC, delayTime: timing.quantum }));
  const straight = echoLine(timing.inLoop());
  input.connect(straightIn).connect(align).connect(straight.delay);
  straight.feedback.connect(straight.delay);
  straight.out.connect(wet);

  // Ping-pong: the mono sum starts on the left and every repeat crosses over.
  const pingIn = node(
    new GainNode(ac, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }),
  );
  const left = echoLine(timing.seconds());
  const right = echoLine(timing.inLoop());
  const merge = node(new ChannelMergerNode(ac, { numberOfInputs: 2 }));
  input.connect(pingIn).connect(left.delay);
  left.feedback.connect(right.delay);
  right.feedback.connect(left.delay);
  left.out.connect(merge, 0, 0);
  right.out.connect(merge, 0, 1);
  merge.connect(wet);

  const isPingPong = params.pingPong.value;
  straightIn.gain.value = isPingPong ? 0 : 1;
  pingIn.gain.value = isPingPong ? 1 : 0;
  params.pingPong.onChange((on, time) => {
    straightIn.gain.setTargetAtTime(on ? 0 : 1, time, MODE_SWITCH_TIME_CONSTANT_SEC);
    pingIn.gain.setTargetAtTime(on ? 1 : 0, time, MODE_SWITCH_TIME_CONSTANT_SEC);
  });

  return {
    input,
    output,
    retime(time, bpm) {
      straight.delay.delayTime.setTargetAtTime(timing.inLoop(bpm), time, RETIME_TIME_CONSTANT_SEC);
      left.delay.delayTime.setTargetAtTime(timing.seconds(bpm), time, RETIME_TIME_CONSTANT_SEC);
      right.delay.delayTime.setTargetAtTime(timing.inLoop(bpm), time, RETIME_TIME_CONSTANT_SEC);
    },
    dispose() {
      for (const n of nodes) n.disconnect();
    },
  };
}
