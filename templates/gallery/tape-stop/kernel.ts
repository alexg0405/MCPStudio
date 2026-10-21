// Pure DSP, no AudioWorklet globals, so it can be tested in Node. Rules: no allocation inside process().
import { at, EffectKernel, type ParamBlock } from '@agstudio/sdk/worklet';
import type { params } from './params';

/** How much sound the tape remembers, in seconds (a slow-down of 4 s lags about 2 s behind the live sound; a longer stop replays the oldest 5 s). */
const TAPE_SECONDS = 5;
/** Below this speed the sound fades out, so a stopped tape is silence and not a held sample (a click). */
const FADE_BELOW_SPEED = 0.125;
/** How long the hand-over from the spinning tape back to the live sound takes, in seconds. */
const HAND_BACK_SECONDS = 0.02;
/** The speed at which the tape counts as "back to normal" and the hand-over may begin. */
const NORMAL_SPEED = 0.999;

/**
 * A tape stop. The effect passes the sound straight through (no delay) while it records the last seconds. When Stop turns
 * on, it plays that recording back at a speed that falls to zero, so the pitch and the tempo sink like a tape machine
 * switched off. When Stop turns off, the speed climbs back and the live sound is faded in as it arrives.
 */
export class TapeStopKernel extends EffectKernel<typeof params> {
  private readonly size = Math.ceil(this.sampleRate * TAPE_SECONDS);
  private readonly tape: [Float32Array, Float32Array] = [new Float32Array(this.size), new Float32Array(this.size)];
  /** Frames written so far (counted without wrapping; the tape is a ring of `size`). */
  private written = 0;
  /** Where the tape is read from, in frames, with a fraction. */
  private readAt = 0;
  private speed = 1;
  /** 1 while the tape plays the recording (stopping, stopped or spinning up); false while the sound is live. */
  private isOnTape = false;
  /** 0 = only the tape is heard, 1 = only the live sound (the hand-over at the end of a spin up). */
  private live = 0;

  override reset(): void {
    this.tape[0].fill(0);
    this.tape[1].fill(0);
    this.written = 0;
    this.readAt = 0;
    this.speed = 1;
    this.isOnTape = false;
    this.live = 0;
  }

  /** One channel of the recording at a fractional position (linear interpolation); silence before the start. */
  private tapeAt(channel: number, position: number): number {
    if (position < 0) return 0;
    const whole = Math.floor(position);
    const fraction = position - whole;
    const ring = this.tape[channel] as Float32Array;
    const a = ring[whole % this.size] as number;
    const b = ring[(whole + 1) % this.size] as number;
    return a + (b - a) * fraction;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<typeof params>): void {
    const channels = Math.min(output.length, 2);
    const slowStep = 1 / (Math.max(0.01, at(p.slowDown, 0)) * this.sampleRate);
    const spinStep = 1 / (Math.max(0.01, at(p.spinUp, 0)) * this.sampleRate);
    const handBackStep = 1 / (HAND_BACK_SECONDS * this.sampleRate);
    for (let i = 0; i < n; i++) {
      // The newest sound is always recorded, even while the tape plays the past, so the tape can never run out.
      for (let c = 0; c < channels; c++) (this.tape[c] as Float32Array)[this.written % this.size] = (input[c] as Float32Array)[i] as number;
      this.written++;
      const wantsStop = at(p.stop, i) > 0.5;
      if (!this.isOnTape && wantsStop) {
        // Start from the newest recorded frame (one behind it, so the interpolation never reads what is not written yet).
        this.isOnTape = true;
        this.speed = 1;
        this.live = 0;
        this.readAt = Math.max(0, this.written - 2);
      }
      if (!this.isOnTape) {
        for (let c = 0; c < channels; c++) (output[c] as Float32Array)[i] = (input[c] as Float32Array)[i] as number;
        continue;
      }
      this.speed = wantsStop ? Math.max(0, this.speed - slowStep) : Math.min(1, this.speed + spinStep);
      const isBackToNormal = !wantsStop && this.speed >= NORMAL_SPEED;
      this.live = isBackToNormal ? Math.min(1, this.live + handBackStep) : Math.max(0, this.live - handBackStep);
      const fade = Math.min(1, this.speed / FADE_BELOW_SPEED);
      for (let c = 0; c < channels; c++) {
        const heard = this.tapeAt(c, this.readAt) * fade;
        const sample = (input[c] as Float32Array)[i] as number;
        (output[c] as Float32Array)[i] = heard + (sample - heard) * this.live;
      }
      this.readAt += this.speed;
      // After a stop longer than the tape, the oldest sound still on it is what plays when it spins up.
      this.readAt = Math.max(this.readAt, this.written - this.size + 2);
      if (this.live >= 1) this.isOnTape = false;
    }
  }
}
