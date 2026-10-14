// Band-limited oscillators (PolyBLEP). Allocation-free; usable on any thread.

/**
 * The PolyBLEP correction for a step at phase 0: subtract it (scaled by the step size) around each
 * discontinuity to remove most of the aliasing. `t` is the phase (0–1), `dt` the phase increment.
 */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export type BlepWave = 'sine' | 'saw' | 'square' | 'pulse' | 'triangle';

/**
 * A single oscillator with low aliasing: saw and square/pulse with PolyBLEP, the triangle as a leaky
 * integral of the band-limited square. `next(freq)` returns −1…1 and advances one sample.
 */
export class BlepOscillator {
  wave: BlepWave = 'saw';
  /** Pulse width for 'pulse' (0.01–0.99); 'square' is 0.5. */
  width = 0.5;
  /** Phase 0–1 (use reset() to restart the cycle, e.g. for hard sync or a fixed start phase). */
  phase = 0;
  /** The triangle's integrator, started where a triangle at this phase is (no DC to settle). */
  private tri = -1;

  constructor(private readonly sampleRate: number) {}

  reset(phase = 0): void {
    this.phase = phase - Math.floor(phase);
    this.tri = this.phase < 0.5 ? -1 + 4 * this.phase : 3 - 4 * this.phase;
  }

  next(freq: number): number {
    const dt = Math.min(0.5, Math.abs(freq) / this.sampleRate);
    const t = this.phase;
    let y: number;
    switch (this.wave) {
      case 'sine':
        y = Math.sin(2 * Math.PI * t);
        break;
      case 'saw':
        y = 2 * t - 1 - polyBlep(t, dt);
        break;
      case 'square':
      case 'pulse':
      case 'triangle': {
        const w = this.wave === 'pulse' ? Math.min(0.99, Math.max(0.01, this.width)) : 0.5;
        let sq = t < w ? 1 : -1;
        sq += polyBlep(t, dt);
        let t2 = t - w;
        if (t2 < 0) t2 += 1;
        sq -= polyBlep(t2, dt);
        if (this.wave !== 'triangle') {
          y = sq;
          break;
        }
        // Integrate the square: a triangle at amplitude ~1. The leak (the same share per cycle at
        // any pitch) keeps rounding errors from building up DC.
        this.tri = (1 - 0.05 * dt) * this.tri + 4 * dt * sq;
        y = this.tri;
        break;
      }
    }
    this.phase = t + dt;
    if (this.phase >= 1) this.phase -= 1;
    return y;
  }
}
