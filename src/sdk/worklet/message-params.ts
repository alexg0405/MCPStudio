import type { ParamBlock } from './kernel';

/** A glide counts as arrived when it is this close to its goal (relative to the goal, at least 1). */
const GLIDE_ARRIVED = 1e-7;

/** One event param's description: its name, its starting (encoded) value and its glide time constant in seconds. */
export type MessageParamInit = readonly [name: string, value: number, glideSeconds?: number];

/**
 * The params that reach a kernel as events instead of AudioParams (see `messageParamNames`): each
 * holds one value for the kernel to read. Floats of a lite processor glide to their new value
 * (setTargetAtTime's curve, like the AudioParam they stand in for): `glide` is the per-sample
 * coefficient (0 = the value just changes), `goal` the value the glide is heading to, `now` where it
 * is, and `ramps` the per-sample array the kernel reads while it moves. Allocation-free once the
 * first block of a given size has made its ramps.
 */
export class MessageParams {
  /** What the kernel gets: the AudioParams' arrays and these params' arrays, one object for good. */
  private readonly block: Record<string, Float32Array> = {};
  private readonly names: string[];
  /** The one-value arrays a param shows when it is not gliding. */
  private readonly singles: Float32Array[];
  private readonly glide: Float64Array;
  private readonly goal: Float64Array;
  private readonly now: Float64Array;
  private readonly ramps: (Float32Array | null)[];
  private readonly moving: Uint8Array;
  private anyGlide = false;
  /** Frames of the current block the gliding arrays are filled for. */
  private filled = 0;
  private blockSize = 128;

  constructor(params: readonly MessageParamInit[], sampleRate: number) {
    this.names = params.map(([name]) => name);
    const count = params.length;
    this.glide = new Float64Array(count);
    this.goal = new Float64Array(count);
    this.now = new Float64Array(count);
    this.ramps = new Array<Float32Array | null>(count).fill(null);
    this.moving = new Uint8Array(count);
    this.singles = params.map(([name, value, glideSeconds], i) => {
      const single = new Float32Array([value]);
      this.block[name] = single;
      this.goal[i] = value;
      this.now[i] = value;
      if (glideSeconds && glideSeconds > 0) {
        this.glide[i] = 1 - Math.exp(-1 / (glideSeconds * sampleRate));
        this.anyGlide = true;
      }
      return single;
    });
  }

  /** How many event params there are. */
  get count(): number {
    return this.singles.length;
  }

  /** A new render block of `frames` frames starts: nothing is filled yet. */
  beginBlock(frames: number): void {
    this.blockSize = frames;
    this.filled = 0;
  }

  /**
   * The param block the kernel reads this quantum. With no event params it is the browser's own
   * `params`; otherwise the AudioParams' arrays (new every block) join the event params' arrays (which stay).
   */
  blockWith(audioParamNames: readonly string[], params: Record<string, Float32Array>): ParamBlock {
    if (this.singles.length === 0) return params as unknown as ParamBlock;
    for (let i = 0; i < audioParamNames.length; i++) {
      const name = audioParamNames[i] as string;
      this.block[name] = params[name] as Float32Array;
    }
    return this.block as unknown as ParamBlock;
  }

  /** An event sets param `index` to the encoded `value`: at once, or as a glide towards it. */
  set(index: number, value: number): void {
    const single = this.singles[index];
    if (!single) return;
    if ((this.glide[index] as number) > 0) {
      // Glides head for the new value from where they are, starting at the frames not yet filled.
      this.goal[index] = value;
      this.moving[index] = 1;
    } else single[0] = value;
  }

  /** Fills the gliding params' arrays up to frame `upTo` of the block (what kernels read below it). */
  advance(upTo: number): void {
    if (!this.anyGlide || upTo <= this.filled) return;
    const n = this.blockSize;
    for (let i = 0; i < this.moving.length; i++) {
      if (!this.moving[i]) continue;
      let ramp = this.ramps[i] ?? null;
      if (!ramp || ramp.length !== n) {
        ramp = this.ramps[i] = new Float32Array(n);
        this.block[this.names[i] as string] = ramp;
        ramp.fill(this.now[i] as number);
      }
      const goal = this.goal[i] as number;
      const coefficient = this.glide[i] as number;
      let value = this.now[i] as number;
      // The value at the frame, then the step towards the goal (setTargetAtTime: v0 at the event, then v0 to goal).
      for (let frame = this.filled; frame < upTo; frame++) {
        ramp[frame] = value;
        value += (goal - value) * coefficient;
      }
      this.now[i] = value;
    }
    this.filled = upTo;
  }

  /** The block is done: glides that arrived go back to a plain value; the others carry on next block. */
  finishBlock(frames: number): void {
    if (!this.anyGlide) return;
    this.advance(frames);
    for (let i = 0; i < this.moving.length; i++) {
      if (!this.moving[i]) continue;
      const goal = this.goal[i] as number;
      const value = this.now[i] as number;
      if (Math.abs(goal - value) <= GLIDE_ARRIVED * Math.max(1, Math.abs(goal))) {
        this.now[i] = goal;
        this.settle(i);
      }
    }
  }

  /** Glides that were cut short by sleeping land at once (nothing was heard meanwhile). */
  landGlides(): void {
    if (!this.anyGlide) return;
    for (let i = 0; i < this.moving.length; i++)
      if (this.moving[i]) {
        this.now[i] = this.goal[i] as number;
        this.settle(i);
      }
  }

  /** Glide `i` is over: the kernel reads its single value again. */
  private settle(i: number): void {
    this.moving[i] = 0;
    const single = this.singles[i] as Float32Array;
    single[0] = this.now[i] as number;
    this.block[this.names[i] as string] = single;
    this.ramps[i] = null;
  }
}
