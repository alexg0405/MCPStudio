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
 */
export class PitchSignal implements ParamSignal {
  readonly node: GainNode;
  readonly lane: AutoLane;
  private readonly knob: ConstantSourceNode;
  private readonly bend: ConstantSourceNode;
  private bendCents = 0;

  constructor(ctx: BaseAudioContext, key: string, cents: number) {
    this.node = new GainNode(ctx);
    this.knob = new ConstantSourceNode(ctx, { offset: 0 });
    this.bend = new ConstantSourceNode(ctx, { offset: 0 });
    this.lane = new AutoLane(ctx, key, CHANNEL_PITCH_SPEC, cents, PITCH_KNOB_TAU_SEC);
    this.lane.bind(this.knob.offset);
    this.knob.connect(this.node);
    this.bend.connect(this.node);
    this.knob.start();
    this.bend.start();
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

  /** Live pitch bend in cents (MIDI input). */
  setBend(cents: number, time: number): void {
    this.bendCents = cents;
    this.bend.offset.setTargetAtTime(cents, time, PITCH_BEND_TAU_SEC);
  }

  /** The pitch in cents at a context time: the knob's value (with its automation) plus the bend. */
  pitchAt(time: number): number {
    return this.lane.valueAt(time) + this.bendCents;
  }

  dispose(): void {
    for (const source of [this.knob, this.bend]) {
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
}
