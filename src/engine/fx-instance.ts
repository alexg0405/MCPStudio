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
  /** The dry path's delay, as long as the effect's latency (null for an effect without latency). */
  dryDelay: DelayNode | null = null;
  /** The dry path's gate after the delay: opened with the wet gate so the two stay aligned. */
  dryAlign: GainNode | null = null;
  /** The effect's latency in frames (it changes while a rack's effects load and are bypassed: see `setLatencyFrames`). */
  latencyFrames: number;
  /** The slot's dry gain the aligned dry path joins, or null while the slot has no dry/wet stage. */
  private dryMix: AudioNode | null;
  /** The node the effect (and its dry path) is fed from while it is fed. */
  private fedFrom: AudioNode | null = null;
  /** Where the wet gate sends its sound: the slot's wet gain, or (a slot at mix 1) the slot's output. */
  private wetTarget: AudioNode;
  private isFed = false;
  private keySource: AudioNode | null = null;
  private keyFrames = 0;
  /** The key path while connected: source → [keyDelay] → host.sidechain. */
  private isKeyed = false;
  private keyDelay: DelayNode | null = null;
  private stopWatchingSleep: () => void = () => {};

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly effect: EffectInstance,
    readonly host: HostImpl,
    wetTarget: AudioNode,
    /** The slot's dry gain, or null while the slot has no dry path (see FxMixStage). */
    dryMix: AudioNode | null,
    /** The effect's latency in frames. */
    latencyFrames: number,
  ) {
    this.latencyFrames = latencyFrames;
    this.dryMix = dryMix;
    this.wetGate = new GainNode(ctx, { gain: 0 });
    this.wetTarget = wetTarget;
    effect.output.connect(this.wetGate);
    this.wetGate.connect(wetTarget);
    // The delay line is made (and fed) from the start even while the slot has no dry/wet stage to join: its history is
    // the dry sound the stage needs the moment the mix first moves, and a line made then would start empty.
    this.buildDryPath();
  }

  /** Makes the latency-aligned dry path for the current latency (nothing for an effect without latency). */
  private buildDryPath(): void {
    if (this.latencyFrames <= 0) return;
    this.dryDelay = frameDelay(this.ctx, this.latencyFrames);
    this.dryAlign = new GainNode(this.ctx, { gain: 0 });
    this.dryDelay.connect(this.dryAlign);
    if (this.dryMix) this.dryAlign.connect(this.dryMix);
  }

  /**
   * The effect's latency changed (a rack whose effects finished loading or were bypassed): the dry path is made again
   * for the new length, from the same input. Its delay line starts empty, so the dry sound of the next few milliseconds
   * is missing once; the slot's gates are set again by the caller.
   */
  setLatencyFrames(frames: number): void {
    if (frames === this.latencyFrames) return;
    const input = this.fedFrom;
    if (input && this.dryDelay) disconnectFrom(input, this.dryDelay);
    this.dryDelay?.disconnect();
    this.dryAlign?.disconnect();
    this.dryDelay = null;
    this.dryAlign = null;
    this.latencyFrames = frames;
    this.buildDryPath();
    if (input && this.dryDelay) input.connect(this.dryDelay);
  }

  /** The slot made its mix stage: the wet gate now goes through its wet gain, and the (already running) latency-aligned dry path joins its dry gain. */
  useMixStage(wetMix: AudioNode, dryMix: AudioNode): void {
    disconnectFrom(this.wetGate, this.wetTarget);
    this.wetTarget = wetMix;
    this.wetGate.connect(wetMix);
    this.dryMix = dryMix;
    this.dryAlign?.connect(dryMix);
  }

  /** Calls `onChange` whenever the effect wakes from sleep or falls asleep (see the SDK's `Sleeper`). */
  watchSleep(onChange: (asleep: boolean) => void): void {
    this.stopWatchingSleep = this.effect.sleep?.onChange(onChange) ?? (() => {});
  }

  /** The effect has a sidechain input. */
  get listens(): boolean {
    return this.host.sidechain !== null;
  }

  /** Connects or disconnects the slot input to the effect (its aligned dry path and its key too). */
  feed(input: AudioNode, on: boolean): void {
    if (on === this.isFed) return;
    this.isFed = on;
    this.fedFrom = on ? input : null;
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
    this.stopWatchingSleep();
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
