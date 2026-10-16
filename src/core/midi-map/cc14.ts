/**
 * 14-bit controllers (pitch faders) send the coarse byte on CC n (0–31) and the fine byte on CC n+32,
 * on the same channel, coarse first. A value is produced when the fine byte lands (or on the coarse
 * byte while no fine byte has ever been seen).
 */
export class Cc14Assembler {
  private readonly msb = new Map<string, number>();
  private readonly lsb = new Map<string, number>();

  /** Feed one CC of a pair: `cc` is the MSB number (0–31). Returns the 14-bit value (0–16383) once the MSB is known. */
  feed(channel: number, cc: number, isLsb: boolean, value: number): number | null {
    const key = `${channel}:${cc}`;
    if (isLsb) this.lsb.set(key, value);
    else this.msb.set(key, value);
    const hi = this.msb.get(key);
    if (hi === undefined) return null;
    // The fine byte follows the coarse one (MIDI convention): once a pair has sent one, wait for it so the value does not step.
    if (!isLsb && this.lsb.has(key)) return null;
    return (hi << 7) | (this.lsb.get(key) ?? 0);
  }

  reset(): void {
    this.msb.clear();
    this.lsb.clear();
  }
}

/** 0–16383 → 0–1. */
export const norm14 = (v: number): number => v / 16383;
