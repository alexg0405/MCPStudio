/**
 * Smoothed stereo statistics of one signal (or one band of it): the average power of the left channel, of the right
 * channel and of their product. Correlation, width and mono loss all follow from these three numbers. Pure and
 * allocation-free; used on the audio thread.
 */
export class StereoStats {
  leftPower = 0;
  rightPower = 0;
  /** Average of left × right: positive when the channels move together, negative when against each other. */
  crossPower = 0;

  /** Adds one frame, smoothing with `smoothing` (the share of the new frame, 0 to 1). */
  update(left: number, right: number, smoothing: number): void {
    this.leftPower += (left * left - this.leftPower) * smoothing;
    this.rightPower += (right * right - this.rightPower) * smoothing;
    this.crossPower += (left * right - this.crossPower) * smoothing;
  }

  reset(): void {
    this.leftPower = this.rightPower = this.crossPower = 0;
  }

  /** −1 (opposite polarity) to +1 (the same signal); 0 for unrelated channels and for silence. */
  correlation(): number {
    const energy = Math.sqrt(this.leftPower * this.rightPower);
    if (energy < 1e-12) return 0;
    return Math.max(-1, Math.min(1, this.crossPower / energy));
  }

  /** Share of the side signal: side / (mid + side) in RMS, 0 for mono, 0.5 for unrelated channels, 1 for opposite polarity. */
  width(): number {
    const mid = Math.max(0, (this.leftPower + this.rightPower + 2 * this.crossPower) / 4);
    const side = Math.max(0, (this.leftPower + this.rightPower - 2 * this.crossPower) / 4);
    const midRms = Math.sqrt(mid);
    const sideRms = Math.sqrt(side);
    return midRms + sideRms > 1e-9 ? sideRms / (midRms + sideRms) : 0;
  }

  /** How many dB the signal loses summed to mono ((L+R)/2 against the channels' mean power): 0 for mono, −3 for unrelated. */
  monoLossDb(): number {
    const total = this.leftPower + this.rightPower;
    if (total < 1e-14) return 0;
    const kept = (total + 2 * this.crossPower) / (2 * total);
    return kept > 1e-6 ? 10 * Math.log10(kept) : MONO_LOSS_FLOOR_DB;
  }

  /** Level of the two channels together (dBFS RMS). */
  levelDb(): number {
    const mean = (this.leftPower + this.rightPower) / 2;
    return mean > 0 ? 10 * Math.log10(mean) : -Infinity;
  }
}

/** An out-of-phase signal vanishes in mono: report it as this instead of −Infinity. */
export const MONO_LOSS_FLOOR_DB = -60;
