// Low-frequency oscillator, free-running or locked to the song. Allocation-free; usable on any thread.

/** The shape of an LFO's cycle. */
export type LfoShape = 'sine' | 'triangle' | 'saw' | 'ramp' | 'square' | 'random' | 'smooth';

/** A repeatable value in −1…1 for cycle `n` (random shapes stay the same on every playback). */
function hashed(n: number, seed: number): number {
  let h = Math.imul((n | 0) ^ seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/**
 * An LFO in −1…1. `next(rateHz)` runs freely; `atBeat(beat, periodBeats)` follows the song position
 * (KernelTransport.beatAt), so tempo-synced modulation lands on the beat every time it plays.
 * Shapes: sine, triangle, saw (rising), ramp (falling), square, random (sample and hold once per
 * cycle) and smooth (random values with smooth steps).
 */
export class Lfo {
  shape: LfoShape = 'sine';
  /** Phase 0–1 of the free-running LFO. */
  phase = 0;
  private cycle = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly seed = 1,
  ) {}

  /** The shape's value at a phase (0–1) of cycle `n`. */
  valueAt(phase: number, n = 0): number {
    const t = phase - Math.floor(phase);
    switch (this.shape) {
      case 'sine':
        return Math.sin(2 * Math.PI * t);
      case 'triangle':
        return t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
      case 'saw':
        return 2 * t - 1;
      case 'ramp':
        return 1 - 2 * t;
      case 'square':
        return t < 0.5 ? 1 : -1;
      case 'random':
        return hashed(n, this.seed);
      case 'smooth': {
        const a = hashed(n, this.seed);
        const b = hashed(n + 1, this.seed);
        const s = (1 - Math.cos(Math.PI * t)) / 2;
        return a + (b - a) * s;
      }
    }
  }

  /** Advances one sample at `rateHz` and returns the value. */
  next(rateHz: number): number {
    const y = this.valueAt(this.phase, this.cycle);
    this.phase += rateHz / this.sampleRate;
    if (this.phase >= 1) {
      const whole = Math.floor(this.phase);
      this.phase -= whole;
      this.cycle += whole;
    }
    return y;
  }

  /** The value at a song position in beats, for a cycle of `periodBeats` beats starting at `offset` (0–1). */
  atBeat(beat: number, periodBeats: number, offset = 0): number {
    const pos = beat / Math.max(1e-9, periodBeats) + offset;
    const n = Math.floor(pos);
    return this.valueAt(pos - n, n);
  }

  reset(phase = 0): void {
    this.phase = phase;
    this.cycle = 0;
  }
}
