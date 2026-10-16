/**
 * Soft takeover (pickup): when a physical fader or knob is not where the software value is (the
 * mouse moved it, a song loaded, a layer changed), the control does nothing until the hardware reaches
 * the software value, so the value never jumps. Positions are 0–1.
 */
export const PICKUP_TOLERANCE = 0.03;

export class SoftTakeover {
  private picked = false;
  private lastHw: number | null = null;
  private lastSent: number | null = null;

  /**
   * The value to apply for a hardware move to `hw`, given the software's `current` value; null while
   * the hardware has not picked the value up yet.
   */
  feed(hw: number, current: number): number | null {
    // Something else moved the software value since we last wrote it: pick up again.
    if (this.picked && this.lastSent !== null && Math.abs(current - this.lastSent) > PICKUP_TOLERANCE) this.picked = false;
    if (!this.picked) {
      const near = Math.abs(hw - current) <= PICKUP_TOLERANCE;
      const crossed = this.lastHw !== null && (this.lastHw - current) * (hw - current) <= 0;
      if (near || crossed) this.picked = true;
    }
    this.lastHw = hw;
    if (!this.picked) return null;
    this.lastSent = hw;
    return hw;
  }

  /** Forget the pickup (a layer change, a new song): the next move has to meet the software value again. */
  invalidate(): void {
    this.picked = false;
    this.lastHw = null;
    this.lastSent = null;
  }

  get pickedUp(): boolean {
    return this.picked;
  }
}
