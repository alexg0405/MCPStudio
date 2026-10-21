/**
 * How a rack splits its input between its branches and puts them together again. One class per split mode, all behind
 * `SplitNetwork`: the rack asks each for the node that feeds branch `i`, and hands it each branch's output to join the sum.
 *
 *   parallel   every branch is fed the input itself; the outputs just add up
 *   bands      Linkwitz-Riley (24 dB/oct) crossovers cut the input into bands, lowest first. The bands that are not the top one
 *              pass through the later crossovers' allpass, so the bands add up to the input again (flat to the last bit of
 *              the filters' precision, only the phase turns)
 *   midside    branch 0 hears the mid (L + R) / 2 and branch 1 the side (L − R) / 2, each as the same signal on both channels;
 *              the mid comes back as it is, the side as (+S left, −S right), so doing nothing gives the input back exactly
 *   leftright  branch 0 hears the left channel and branch 1 the right one, each on both channels; each comes back to its side
 *              (a stereo result is mixed down to one channel first)
 */
import type { RackSplit } from '@core/model/types';
import type { OrderedMix } from '@agstudio/sdk';
import { disconnectFrom } from '../audio-graph';
import type { AutoLane } from '../param-lane';

/** The Q of a second-order Butterworth filter, in the decibels a Web Audio low-pass or high-pass wants: 20·log10(1/√2). */
const BUTTERWORTH_Q_DB = -3.0102999566398116;
/** The Q of the second-order allpass that matches a Linkwitz-Riley crossover's phase (linear, 1/√2). */
const ALLPASS_Q = Math.SQRT1_2;

/** One split mode's wiring between the rack's input and its sum. */
export interface SplitNetwork {
  /** The node whose output feeds branch `index`. */
  feed(index: number): AudioNode;
  /** Connects the output of branch `index` to where it joins the sum; returns the way to disconnect it. */
  join(index: number, output: AudioNode): () => void;
  /** Disconnects and drops everything the network made. */
  dispose(): void;
}

/** What a split is built from. */
export interface SplitContext {
  ctx: BaseAudioContext;
  /** The rack's input (a stereo gain). */
  input: AudioNode;
  /** The sum the branches join. */
  sum: OrderedMix;
  /** How many branches there are. */
  branches: number;
  /** One lane per crossover of a `bands` rack (they drive the filters' frequencies). */
  crossoverLanes: readonly AutoLane[];
}

/** A node that makes any input stereo and keeps it stereo: mono is copied to both channels. */
function stereoGain(ctx: BaseAudioContext, gain = 1): GainNode {
  return new GainNode(ctx, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
}

/** A node that adds whatever reaches it into one channel. */
function monoGain(ctx: BaseAudioContext, gain: number): GainNode {
  return new GainNode(ctx, { gain, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
}

class ParallelSplit implements SplitNetwork {
  constructor(private readonly split: SplitContext) {}

  feed(): AudioNode {
    return this.split.input;
  }

  join(_index: number, output: AudioNode): () => void {
    return this.split.sum.attach(output);
  }

  dispose(): void {}
}

/** One Linkwitz-Riley crossover: a low-pass and a high-pass of 24 dB/oct from two Butterworth filters each. */
class Crossover {
  readonly low: BiquadFilterNode[];
  readonly high: BiquadFilterNode[];
  /** The allpasses that give another band this crossover's phase, made as bands ask for them. */
  private readonly phase: BiquadFilterNode[] = [];
  private readonly unbind: (() => void)[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly lane: AutoLane,
  ) {
    this.low = [this.filter('lowpass'), this.filter('lowpass')];
    this.high = [this.filter('highpass'), this.filter('highpass')];
    this.low[0]?.connect(this.low[1] as BiquadFilterNode);
    this.high[0]?.connect(this.high[1] as BiquadFilterNode);
  }

  /** The filters' input: the low and high halves both listen to it. */
  connectInput(source: AudioNode): void {
    source.connect(this.low[0] as BiquadFilterNode);
    source.connect(this.high[0] as BiquadFilterNode);
  }

  get lowOut(): AudioNode {
    return this.low[1] as BiquadFilterNode;
  }

  get highOut(): AudioNode {
    return this.high[1] as BiquadFilterNode;
  }

  /** An allpass with this crossover's phase, for a band that does not pass through the crossover itself. */
  phaseMatch(): BiquadFilterNode {
    const node = this.filter('allpass', ALLPASS_Q);
    this.phase.push(node);
    return node;
  }

  dispose(): void {
    for (const stop of this.unbind) stop();
    for (const node of [...this.low, ...this.high, ...this.phase]) node.disconnect();
  }

  private filter(type: BiquadFilterType, q = BUTTERWORTH_Q_DB): BiquadFilterNode {
    const node = new BiquadFilterNode(this.ctx, { type, Q: q, frequency: this.lane.base });
    this.unbind.push(this.lane.bind(node.frequency));
    return node;
  }
}

class BandSplit implements SplitNetwork {
  private readonly crossovers: Crossover[] = [];
  private readonly bandOut: AudioNode[] = [];
  private readonly joins: (() => void)[] = [];

  constructor(private readonly split: SplitContext) {
    const { ctx, input, branches, crossoverLanes } = split;
    // Each crossover cuts what is left above the one before it.
    let rest: AudioNode = input;
    const bands: AudioNode[] = [];
    for (let i = 0; i < branches - 1; i++) {
      const crossover = new Crossover(ctx, crossoverLanes[i] as AutoLane);
      crossover.connectInput(rest);
      this.crossovers.push(crossover);
      bands.push(crossover.lowOut);
      rest = crossover.highOut;
    }
    bands.push(rest);
    // A band takes the phase of every crossover above it, so the bands add up to a flat sound.
    this.bandOut = bands.map((band, index) => {
      let node = band;
      for (let later = index + 1; later < branches - 1; later++) {
        const match = (this.crossovers[later] as Crossover).phaseMatch();
        node.connect(match);
        node = match;
      }
      return node;
    });
  }

  feed(index: number): AudioNode {
    return this.bandOut[index] as AudioNode;
  }

  join(_index: number, output: AudioNode): () => void {
    return this.split.sum.attach(output);
  }

  dispose(): void {
    for (const crossover of this.crossovers) crossover.dispose();
    for (const node of this.bandOut) node.disconnect();
    this.crossovers.length = 0;
    this.bandOut.length = 0;
  }
}

class MidSideSplit implements SplitNetwork {
  private readonly nodes: AudioNode[] = [];
  private readonly mid: GainNode;
  private readonly side: GainNode;
  /** The side branch's output comes in here: (+S on the left, −S on the right). */
  private readonly sideReturn: GainNode;
  private readonly detachSide: () => void;

  constructor(private readonly split: SplitContext) {
    const { ctx, input } = split;
    const channels = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    input.connect(channels);
    const midMono = monoGain(ctx, 0.5);
    const sideMono = monoGain(ctx, 0.5);
    const negateRight = new GainNode(ctx, { gain: -1 });
    channels.connect(midMono, 0);
    channels.connect(midMono, 1);
    channels.connect(sideMono, 0);
    channels.connect(negateRight, 1);
    negateRight.connect(sideMono);
    this.mid = stereoGain(ctx);
    this.side = stereoGain(ctx);
    midMono.connect(this.mid);
    sideMono.connect(this.side);
    // Decoding the side: its right channel comes back inverted.
    this.sideReturn = stereoGain(ctx);
    const sideChannels = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    const negateSide = new GainNode(ctx, { gain: -1 });
    const decoded = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.sideReturn.connect(sideChannels);
    sideChannels.connect(decoded, 0, 0);
    sideChannels.connect(negateSide, 1);
    negateSide.connect(decoded, 0, 1);
    this.detachSide = split.sum.attach(decoded);
    this.nodes.push(channels, midMono, sideMono, negateRight, this.mid, this.side, this.sideReturn, sideChannels, negateSide, decoded);
  }

  feed(index: number): AudioNode {
    return index === 0 ? this.mid : this.side;
  }

  join(index: number, output: AudioNode): () => void {
    if (index === 0) return this.split.sum.attach(output);
    output.connect(this.sideReturn);
    return () => disconnectFrom(output, this.sideReturn);
  }

  dispose(): void {
    this.detachSide();
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }
}

class LeftRightSplit implements SplitNetwork {
  private readonly nodes: AudioNode[] = [];
  private readonly left: GainNode;
  private readonly right: GainNode;
  private readonly merged: ChannelMergerNode;
  private readonly detach: () => void;

  constructor(split: SplitContext) {
    const { ctx, input } = split;
    const channels = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    input.connect(channels);
    const leftMono = monoGain(ctx, 1);
    const rightMono = monoGain(ctx, 1);
    channels.connect(leftMono, 0);
    channels.connect(rightMono, 1);
    this.left = stereoGain(ctx);
    this.right = stereoGain(ctx);
    leftMono.connect(this.left);
    rightMono.connect(this.right);
    // Each branch returns to its own side: a merger input is one channel, so a stereo output is mixed down to one.
    this.merged = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.detach = split.sum.attach(this.merged);
    this.nodes.push(channels, leftMono, rightMono, this.left, this.right, this.merged);
  }

  feed(index: number): AudioNode {
    return index === 0 ? this.left : this.right;
  }

  join(index: number, output: AudioNode): () => void {
    output.connect(this.merged, 0, index);
    return () => {
      try {
        output.disconnect(this.merged, 0, index);
      } catch {
        /* not connected */
      }
    };
  }

  dispose(): void {
    this.detach();
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }
}

/** Builds the wiring of a split mode. */
export function makeSplitNetwork(mode: RackSplit, split: SplitContext): SplitNetwork {
  switch (mode) {
    case 'parallel':
      return new ParallelSplit(split);
    case 'bands':
      return new BandSplit(split);
    case 'midside':
      return new MidSideSplit(split);
    case 'leftright':
      return new LeftRightSplit(split);
  }
}
