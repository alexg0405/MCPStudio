import type { EffectInstance } from '@agstudio/sdk';
import { disconnectFrom, frameDelay } from './audio-graph';
import type { HostImpl } from './host';

/**
 * One live effect instance inside a slot: its wet gate, its latency-aligned dry path and its sidechain key.
 * (The slot's own gains decide which instance is heard; see FxSlotStrip.)
 */
export class FxInstance {
  /** The wet path's gate: the slot opens it while this is the live instance. */
  readonly wetGate: GainNode;
  /** The dry path's delay, as long as the effect's latency (null for an effect without latency, or while the slot has no dry path). */
  dryDelay: DelayNode | null = null;
  /** The dry path's gate after the delay: opened with the wet gate so the two stay aligned. */
  dryAlign: GainNode | null = null;
  /** Where the wet gate sends its sound: the slot's wet gain, or (a slot at mix 1) the slot's output. */
  private wetTarget: AudioNode;
  private isFed = false;
  private keySource: AudioNode | null = null;
  private keyFrames = 0;
  /** The key path while connected: source → [keyDelay] → host.sidechain. */
  private isKeyed = false;
  private keyDelay: DelayNode | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly effect: EffectInstance,
    readonly host: HostImpl,
    wetTarget: AudioNode,
    /** The slot's dry gain, or null while the slot has no dry path (see FxMixStage). */
    dryMix: AudioNode | null,
    /** The effect's latency in frames. */
    readonly latencyFrames: number,
  ) {
    this.wetGate = new GainNode(ctx, { gain: 0 });
    this.wetTarget = wetTarget;
    effect.output.connect(this.wetGate);
    this.wetGate.connect(wetTarget);
    if (dryMix) this.addDryPath(dryMix);
  }

  /** The slot made its mix stage: the wet gate now goes through its wet gain, and the latency-aligned dry path joins its dry gain. */
  useMixStage(wetMix: AudioNode, dryMix: AudioNode, input: AudioNode): void {
    disconnectFrom(this.wetGate, this.wetTarget);
    this.wetTarget = wetMix;
    this.wetGate.connect(wetMix);
    this.addDryPath(dryMix);
    if (this.isFed && this.dryDelay) input.connect(this.dryDelay);
  }

  /** The delayed dry path for an effect with latency (nothing for one without). */
  private addDryPath(dryMix: AudioNode): void {
    if (this.latencyFrames <= 0 || this.dryDelay) return;
    this.dryDelay = frameDelay(this.ctx, this.latencyFrames);
    this.dryAlign = new GainNode(this.ctx, { gain: 0 });
    this.dryDelay.connect(this.dryAlign);
    this.dryAlign.connect(dryMix);
  }

  /** The effect has a sidechain input. */
  get listens(): boolean {
    return this.host.sidechain !== null;
  }

  /** Connects or disconnects the slot input to the effect (its aligned dry path and its key too). */
  feed(input: AudioNode, on: boolean): void {
    if (on === this.isFed) return;
    this.isFed = on;
    if (on) {
      input.connect(this.effect.input);
      if (this.dryDelay) input.connect(this.dryDelay);
    } else {
      disconnectFrom(input, this.effect.input);
      if (this.dryDelay) disconnectFrom(input, this.dryDelay);
    }
    this.syncKey();
  }

  /** What feeds the effect's sidechain input, padded by `frames` (delay compensation). */
  setKey(source: AudioNode, frames: number): void {
    if (source === this.keySource && frames === this.keyFrames) return;
    this.unkey();
    this.keySource = source;
    this.keyFrames = frames;
    this.syncKey();
  }

  /** Disconnects everything and disposes the effect and its host; `input` is the slot input it was fed from. */
  dispose(input: AudioNode): void {
    this.feed(input, false);
    this.unkey();
    disconnectFrom(this.effect.output, this.wetGate);
    this.wetGate.disconnect();
    this.dryDelay?.disconnect();
    this.dryAlign?.disconnect();
    try {
      this.effect.dispose();
    } catch (err) {
      console.error('effect dispose failed', err);
    }
    this.host.dispose();
  }

  /** Connects the key path when the effect is fed, listens to a sidechain and has a key source; else takes it away. */
  private syncKey(): void {
    const sidechain = this.host.sidechain;
    const wantKey = this.isFed && sidechain !== null && this.keySource !== null;
    if (wantKey === this.isKeyed) return;
    if (!wantKey) {
      this.unkey();
      return;
    }
    const source = this.keySource as AudioNode;
    const target = sidechain as AudioNode;
    if (this.keyFrames > 0) {
      this.keyDelay = frameDelay(this.ctx, this.keyFrames);
      source.connect(this.keyDelay).connect(target);
    } else {
      source.connect(target);
    }
    this.isKeyed = true;
  }

  private unkey(): void {
    if (!this.isKeyed) return;
    this.isKeyed = false;
    const source = this.keySource as AudioNode;
    const target = this.host.sidechain as AudioNode;
    if (this.keyDelay) {
      disconnectFrom(source, this.keyDelay);
      this.keyDelay.disconnect();
      this.keyDelay = null;
    } else {
      disconnectFrom(source, target);
    }
  }
}
