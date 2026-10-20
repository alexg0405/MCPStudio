import type { Zone } from './zones';

/**
 * What the overlap-add needs of a time map: the input frame each output frame comes from, and which kept zone (played at
 * the input's own speed) an output frame is in. Both are asked in increasing order of output frame.
 */
export interface FrameTimeMap {
  /** The (fractional) input frame for output frame `o`. */
  inputFrameAt(o: number): number;
  /** Index of the kept zone whose span contains output frame `o`, or −1. */
  zoneAt(o: number): number;
}

/**
 * Which input frame each output frame comes from: slope 1 / scale, except around kept attacks
 * where the input plays at its own speed (slope 1). Both lookups remember where the last one was,
 * so they must be asked in increasing order of output frame (which the frame loop does).
 */
export class TimeMap implements FrameTimeMap {
  /** Anchor points (output frame, input frame), increasing in both. */
  private readonly outFrames: number[] = [0];
  private readonly inFrames: number[] = [0];
  private segment = 0;
  private zoneIndex = 0;

  /**
   * `pre` and `post` are how much of the input each zone keeps before and after its attack, so a
   * zone covers output frames [oc − pre, oc + post].
   */
  constructor(
    private readonly zones: readonly Zone[],
    private readonly pre: number,
    private readonly post: number,
    inLen: number,
    outLen: number,
  ) {
    for (const z of zones) {
      this.outFrames.push(z.oc - pre, z.oc + post);
      this.inFrames.push(z.c - pre, z.c + post);
    }
    this.outFrames.push(outLen);
    this.inFrames.push(inLen);
  }

  /** The (fractional) input frame for output frame `o`. */
  inputFrameAt(o: number): number {
    const outFrames = this.outFrames;
    const inFrames = this.inFrames;
    while (this.segment < outFrames.length - 2 && o >= (outFrames[this.segment + 1] as number)) this.segment++;
    const o0 = outFrames[this.segment] as number;
    const o1 = outFrames[this.segment + 1] as number;
    const i0 = inFrames[this.segment] as number;
    const i1 = inFrames[this.segment + 1] as number;
    return o1 > o0 ? i0 + ((o - o0) * (i1 - i0)) / (o1 - o0) : i0;
  }

  /** Index of the zone whose kept span contains output frame `o`, or −1. */
  zoneAt(o: number): number {
    while (this.zoneIndex < this.zones.length && (this.zones[this.zoneIndex] as Zone).oc + this.post < o) {
      this.zoneIndex++;
    }
    const zone = this.zones[this.zoneIndex];
    return zone && o >= zone.oc - this.pre ? this.zoneIndex : -1;
  }
}
