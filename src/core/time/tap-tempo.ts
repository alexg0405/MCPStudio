/**
 * Tap tempo: tap a beat (a key or a button) and the tempo follows. The average of the last few
 * intervals, so one uneven tap doesn't jump it; a pause of two seconds starts over.
 */
export class TapTempo {
  private taps: number[] = [];

  constructor(
    private readonly maxGapMs = 2000,
    private readonly window = 4,
  ) {}

  /** Records a tap at `nowMs`; the tempo in BPM once there are two taps, else null. */
  tap(nowMs: number): number | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && nowMs - last > this.maxGapMs) this.taps = [];
    this.taps.push(nowMs);
    if (this.taps.length > this.window + 1) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = (this.taps[this.taps.length - 1] as number) - (this.taps[0] as number);
    return (60000 * (this.taps.length - 1)) / span;
  }

  reset(): void {
    this.taps = [];
  }
}
