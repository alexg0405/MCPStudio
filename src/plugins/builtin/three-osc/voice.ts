import { mtof, OrderedMix, type GraphVoice, type NoteOn, type ParamSignal, type PluginHost } from '@agstudio/sdk';
import type { threeOscParams } from './params';

export type ThreeOscHost = PluginHost<typeof threeOscParams, undefined>;

/** Which oscillator: 1, 2 or 3. */
type OscN = 1 | 2 | 3;
const OSCILLATORS = [1, 2, 3] as const;

/** Time the filter envelope takes to rise to its peak at a note's start, seconds. */
const FILTER_ENV_RISE_SEC = 0.003;
/** The decay stages are exponential; these divide the knob's time into the time constant (about 95 % done at the knob's time). */
const FILTER_ENV_TIME_CONSTANTS = 3;
const AMP_DECAY_TIME_CONSTANTS = 4;
const AMP_RELEASE_TIME_CONSTANTS = 5;
/** Cents in one octave: the filter's envelope amount knob is in octaves. */
const CENTS_PER_OCTAVE = 1200;
/** Cents in one semitone: the coarse knobs are in semitones. */
const CENTS_PER_SEMITONE = 100;

/** The smoothed control signals shared by every sounding voice, so every knob is live. */
export interface SharedSignals {
  /** Per oscillator (index 0 is oscillator 1). */
  level: ParamSignal[];
  coarse: ParamSignal[];
  fine: ParamSignal[];
  cutoff: ParamSignal;
  q: ParamSignal;
  envAmount: ParamSignal;
}

/** One smoothed control source per param, created once per instrument. */
export function createSharedSignals(params: ThreeOscHost['params']): SharedSignals {
  const level = (n: OscN) => params[`osc${n}Level`].signal();
  const coarse = (n: OscN) => params[`osc${n}Coarse`].signal((semitones) => semitones * CENTS_PER_SEMITONE);
  const fine = (n: OscN) => params[`osc${n}Fine`].signal();
  return {
    level: [level(1), level(2), level(3)],
    coarse: [coarse(1), coarse(2), coarse(3)],
    fine: [fine(1), fine(2), fine(3)],
    cutoff: params.cutoff.signal(),
    q: params.resonance.signal(),
    envAmount: params.filterEnv.signal((octaves) => octaves * CENTS_PER_OCTAVE),
  };
}

/** What a voice has created so far: the nodes to stop, to disconnect, and the connections to undo. */
interface VoiceParts {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  cleanup: Array<() => void>;
}

/** The three oscillators, each through its own level gain into the mix (all pitch and level knobs stay live). */
function addOscillators(
  host: ThreeOscHost,
  signals: SharedSignals,
  parts: VoiceParts,
  mix: OrderedMix,
  note: { time: number; frequency: number; fine: number | undefined },
): void {
  const ac = host.audioContext;
  const params = host.params;
  for (const n of OSCILLATORS) {
    const oscillator = new OscillatorNode(ac, {
      type: params[`osc${n}Wave`].valueAt(note.time),
      frequency: note.frequency,
      detune: note.fine ?? 0,
    });
    const levelGain = new GainNode(ac, { gain: 0 });
    oscillator.connect(levelGain);
    parts.cleanup.push(mix.attach(levelGain));
    parts.cleanup.push(signals.level[n - 1]!.connect(levelGain.gain));
    parts.cleanup.push(signals.coarse[n - 1]!.connect(oscillator.detune));
    parts.cleanup.push(signals.fine[n - 1]!.connect(oscillator.detune));
    if (host.channel) parts.cleanup.push(host.channel.pitch.connect(oscillator.detune));
    oscillator.start(note.time);
    parts.sources.push(oscillator);
    parts.nodes.push(levelGain);
  }
}

/** The filter envelope: a 0 → 1 → 0 control signal, scaled to cents and added to the filter's detune. */
function addFilterEnvelope(
  host: ThreeOscHost,
  signals: SharedSignals,
  parts: VoiceParts,
  filter: BiquadFilterNode,
  time: number,
): void {
  const ac = host.audioContext;
  const envelope = new ConstantSourceNode(ac, { offset: 0 });
  const depth = new GainNode(ac, { gain: 0 });
  envelope.connect(depth).connect(filter.detune);
  parts.cleanup.push(signals.envAmount.connect(depth.gain));
  envelope.offset.setValueAtTime(0, time);
  envelope.offset.linearRampToValueAtTime(1, time + FILTER_ENV_RISE_SEC);
  const decay = host.params.filterDecay.valueAt(time) / FILTER_ENV_TIME_CONSTANTS;
  envelope.offset.setTargetAtTime(0, time + FILTER_ENV_RISE_SEC, decay);
  envelope.start(time);
  parts.sources.push(envelope);
  parts.nodes.push(depth);
}

/** The amp envelope's attack, decay and sustain (the release is scheduled when the note ends). */
function startAmpEnvelope(host: ThreeOscHost, amp: GainNode, time: number, velocity: number): void {
  const params = host.params;
  const attack = params.attack.valueAt(time);
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(velocity, time + attack);
  amp.gain.setTargetAtTime(
    velocity * params.sustain.valueAt(time),
    time + attack,
    params.decay.valueAt(time) / AMP_DECAY_TIME_CONSTANTS,
  );
}

/**
 * One note's voice: three oscillators summed (in a fixed order) into a low-pass filter and an amp, with the
 * filter and amp envelopes scheduled at the note's start. Returns what `GraphVoices.add` takes.
 */
export function buildVoice(host: ThreeOscHost, signals: SharedSignals, note: NoteOn): GraphVoice {
  const ac = host.audioContext;
  const params = host.params;
  const time = Math.max(note.time, ac.currentTime);
  const sum = new GainNode(ac, { gain: 1 / 2 });
  const filter = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 0, Q: 0 });
  const amp = new GainNode(ac, { gain: 0 });
  sum.connect(filter).connect(amp);
  // The three oscillators add up in a fixed order, so an offline render repeats bit for bit.
  const oscillatorMix = new OrderedMix(ac, sum);
  const parts: VoiceParts = {
    sources: [],
    nodes: [sum, filter],
    cleanup: [() => oscillatorMix.dispose(), signals.cutoff.connect(filter.frequency), signals.q.connect(filter.Q)],
  };

  addOscillators(host, signals, parts, oscillatorMix, { time, frequency: mtof(note.key), fine: note.fine });
  addFilterEnvelope(host, signals, parts, filter, time);
  startAmpEnvelope(host, amp, time, note.velocity);

  return {
    start: time,
    sources: parts.sources,
    out: amp,
    nodes: parts.nodes,
    cleanup: parts.cleanup,
    release: (releaseTime) => {
      const release = params.release.valueAt(releaseTime);
      amp.gain.cancelAndHoldAtTime(releaseTime);
      amp.gain.setTargetAtTime(0, releaseTime, release / AMP_RELEASE_TIME_CONSTANTS);
      return releaseTime + release;
    },
  };
}
