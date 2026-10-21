import { disconnectFrom } from './audio-graph';
import type { AutoLane } from './param-lane';

/**
 * The part of an effect slot that blends the dry and the wet sound by the slot's mix:
 *
 *   input ─► dryGate ─► (the effect's latency-aligned dry path joins here) ─► dryMix (1 − mix) ─► output
 *   effect ─► wetGate ─► wetMix (mix) ─► output
 *
 * The mix is one ConstantSourceNode (offset = mix, written only by the slot's `AutoLane`) driving wetMix's gain directly
 * and dryMix's through an inverter. A slot at mix 1 that nothing drives has no use for any of this (the wet sound passes
 * at gain 1 and the dry one at gain 0), and the always-running constant source with its two AudioParam connections was a
 * large share of an idle mixer's cost, so the slot makes this stage only when its mix first leaves 1 or automation
 * takes the mix over (see `FxSlotStrip.ensureMixStage`).
 */
export class FxMixStage {
  readonly dryGate: GainNode;
  readonly dryMix: GainNode;
  readonly wetMix: GainNode;
  private readonly mixSource: ConstantSourceNode;
  private readonly mixInvert: GainNode;
  private readonly unbind: () => void;

  constructor(ctx: BaseAudioContext, input: AudioNode, output: AudioNode, mixLane: AutoLane) {
    this.dryGate = new GainNode(ctx, { gain: 0 });
    this.dryMix = new GainNode(ctx, { gain: 1 });
    this.wetMix = new GainNode(ctx, { gain: 0 });
    this.mixSource = new ConstantSourceNode(ctx, { offset: 0 });
    this.mixInvert = new GainNode(ctx, { gain: -1 });
    this.mixSource.connect(this.wetMix.gain);
    this.mixSource.connect(this.mixInvert).connect(this.dryMix.gain);
    // Binding replays what the lane holds (the value now and what is scheduled), so a stage made late starts in step.
    this.unbind = mixLane.bind(this.mixSource.offset);
    this.mixSource.start();
    input.connect(this.dryGate).connect(this.dryMix);
    this.dryMix.connect(output);
    this.wetMix.connect(output);
  }

  dispose(input: AudioNode): void {
    this.unbind();
    try {
      this.mixSource.stop();
    } catch {
      /* not started */
    }
    disconnectFrom(input, this.dryGate);
    for (const node of [this.mixSource, this.mixInvert, this.dryGate, this.dryMix, this.wetMix]) node.disconnect();
  }
}
