// Seeded noise generators. Allocation-free; usable on any thread.

export type NoiseColor = 'white' | 'pink' | 'brown';

/**
 * Noise in about −1…1 from a seeded generator, so renders repeat exactly. `white` is flat, `pink`
 * falls 3 dB per octave (Paul Kellet's refined filter: equal energy per octave, like rain or a
 * waterfall), `brown` falls 6 dB per octave (a leaky integrator: rumble). Change `color` any time.
 */
export class Noise {
  color: NoiseColor = 'white';
  private s: number;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  private brown = 0;

  constructor(seed = 1, color: NoiseColor = 'white') {
    this.s = seed >>> 0;
    this.color = color;
  }

  /** Restarts the sequence from `seed` and clears the filters. */
  seed(seed: number): void {
    this.s = seed >>> 0;
    this.reset();
  }

  /** Uniform white noise in [−1, 1) (mulberry32, the same generator as `Rng`). */
  white(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }

  next(): number {
    const w = this.white();
    switch (this.color) {
      case 'white':
        return w;
      case 'pink': {
        this.b0 = 0.99886 * this.b0 + w * 0.0555179;
        this.b1 = 0.99332 * this.b1 + w * 0.0750759;
        this.b2 = 0.969 * this.b2 + w * 0.153852;
        this.b3 = 0.8665 * this.b3 + w * 0.3104856;
        this.b4 = 0.55 * this.b4 + w * 0.5329522;
        this.b5 = -0.7616 * this.b5 - w * 0.016898;
        const pink = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
        this.b6 = w * 0.115926;
        return pink * 0.11;
      }
      case 'brown': {
        let b = (this.brown + 0.02 * w) / 1.02;
        if (!(Math.abs(b) > 1e-20)) b = 0;
        this.brown = b;
        return b * 3.5;
      }
    }
  }

  reset(): void {
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
    this.brown = 0;
  }
}
