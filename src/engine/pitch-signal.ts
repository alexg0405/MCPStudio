import { CHANNEL_PITCH_SPEC } from '@core/model/target-specs';
import type { ParamSignal } from '@agstudio/sdk';
import { AutoLane } from './param-lane';

/** Time constant of a move of the channel's pitch knob (seconds). */
const PITCH_KNOB_TAU_SEC = 0.004;
/** Time constant of a live pitch-bend move (seconds): quick, so the bend follows the wheel. */
const PITCH_BEND_TAU_SEC = 0.002;

/**
 * The channel's pitch in cents: its pitch knob (and automation) plus live pitch bend, summed into
 * one node instruments connect to their voices' detune.
 *
 * The knob's and the bend's ConstantSourceNodes are made only when they carry something: a channel at pitch 0 that is not
 * automated and has not been bent (nearly every channel) has no source running, because an always-running source feeding
 * an AudioParam costs the audio thread a little on every block, for every instrument, for nothing. The detune an
 * instrument connects the node to is 0 without a source, which is what a source at offset 0 gave.
 */
export class PitchSignal implements ParamSignal {
  readonly node: GainNode;
  readonly lane: AutoLane;
  private knob: ConstantSourceNode | null = null;
  private bend: ConstantSourceNode | null = null;
  private bendCents = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    key: string,
    cents: number,
  ) {
    this.node = new GainNode(ctx);
    this.lane = new AutoLane(ctx, key, CHANNEL_PITCH_SPEC, cents, PITCH_KNOB_TAU_SEC);
    // Automation that takes the pitch over needs the knob's source to write to.
    this.lane.onFirstDrive = () => this.ensureKnob();
    if (cents !== 0) this.ensureKnob();
  }

  connect(target: AudioParam): () => void {
    this.node.connect(target);
    return () => {
      try {
        this.node.disconnect(target);
      } catch {
        /* already disconnected */
      }
    };
  }

  /** A change of the channel's pitch knob at context time `time`. */
  setKnob(cents: number, time: number): void {
    if (cents !== 0) this.ensureKnob();
    this.lane.setBase(cents, time);
  }

  /** Live pitch bend in cents (MIDI input). */
  setBend(cents: number, time: number): void {
    this.bendCents = cents;
    // A bend back to 0 on a channel that was never bent has nothing to move.
    if (cents === 0 && !this.bend) return;
    this.bend ??= this.makeSource();
    this.bend.offset.setTargetAtTime(cents, time, PITCH_BEND_TAU_SEC);
  }

  /** The pitch in cents at a context time: the knob's value (with its automation) plus the bend. */
  pitchAt(time: number): number {
    return this.lane.valueAt(time) + this.bendCents;
  }

  dispose(): void {
    for (const source of [this.knob, this.bend]) {
      if (!source) continue;
      try {
        source.stop();
      } catch {
        /* not started */
      }
      source.disconnect();
    }
    this.lane.dispose();
    this.node.disconnect();
  }

  /** Makes the knob's source (binding the lane replays its value), once. */
  private ensureKnob(): void {
    if (this.knob) return;
    this.knob = this.makeSource();
    this.lane.bind(this.knob.offset);
  }

  private makeSource(): ConstantSourceNode {
    const source = new ConstantSourceNode(this.ctx, { offset: 0 });
    source.connect(this.node);
    source.start();
    return source;
  }
}
