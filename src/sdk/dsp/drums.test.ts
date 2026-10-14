import { describe, expect, it } from 'vitest';
import { Clap, HiHat, Kick, Perc, renderDrum, Snare, softClip, Tom, type DrumModel } from './drums';

const SR = 48000;

function rmsOf(x: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(x.length, Math.floor(to));
  for (let i = a; i < b; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Upward zero crossings per second in [from, to). */
function crossingRate(x: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = Math.max(1, from); i < to; i++) if ((x[i - 1] as number) < 0 && (x[i] as number) >= 0) n++;
  return (n * SR) / (to - from);
}

const models: [string, () => DrumModel][] = [
  ['kick', () => new Kick(SR)],
  ['snare', () => new Snare(SR)],
  ['clap', () => new Clap(SR)],
  ['hat', () => new HiHat(SR)],
  ['tom', () => new Tom(SR)],
  ['perc', () => new Perc(SR)],
];

describe('drum models', () => {
  for (const [name, make] of models) {
    it(`${name}: sounds at once, stays finite and in range, fades and stops`, () => {
      const x = renderDrum(make(), 1, 4);
      for (const v of x) expect(Number.isFinite(v)).toBe(true);
      let peak = 0;
      for (const v of x) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.1);
      expect(peak).toBeLessThan(1.6);
      // It stopped by itself, well before the 4 s limit, and the end is quiet.
      expect(x.length).toBeLessThan(4 * SR - 1);
      expect(rmsOf(x, 0, SR * 0.02)).toBeGreaterThan(0.02);
      expect(rmsOf(x, x.length - 480, x.length)).toBeLessThan(1e-3);
    });
  }

  it('velocity scales the hit', () => {
    const loud = renderDrum(new Snare(SR), 1);
    const soft = renderDrum(new Snare(SR), 0.25);
    expect(rmsOf(soft, 0, 4800) / rmsOf(loud, 0, 4800)).toBeCloseTo(0.25, 2);
  });

  it('the kick falls from its sweep onto its pitch', () => {
    const kick = new Kick(SR);
    kick.pitch = 55;
    kick.sweep = 24;
    kick.click = 0;
    kick.drive = 0;
    kick.decay = 1.2;
    const x = renderDrum(kick);
    // 220 Hz at the start, so the first 30 ms average well above the final pitch.
    expect(crossingRate(x, 0, 1440)).toBeGreaterThan(2 * 55);
    expect(crossingRate(x, SR * 0.4, SR * 0.8)).toBeCloseTo(55, -1);
  });

  it('decay sets how long a hit rings', () => {
    const short = new Tom(SR);
    short.decay = 0.2;
    const long = new Tom(SR);
    long.decay = 0.8;
    const a = renderDrum(short);
    const b = renderDrum(long);
    expect(b.length).toBeGreaterThan(a.length * 2.5);
    // About 60 dB down at the decay time.
    const level = (x: Float32Array, t: number) => rmsOf(x, t * SR - 240, t * SR + 240) / rmsOf(x, 0, 960);
    expect(20 * Math.log10(level(b, 0.8))).toBeLessThan(-45);
    expect(20 * Math.log10(level(b, 0.2))).toBeGreaterThan(-25);
  });

  it('choke() silences a voice within 5 ms', () => {
    const hat = new HiHat(SR);
    hat.decay = 1;
    hat.trigger(1);
    for (let i = 0; i < 2400; i++) hat.next();
    hat.choke();
    let n = 0;
    while (hat.active && n < SR) {
      hat.next();
      n++;
    }
    expect(n).toBeLessThanOrEqual(Math.ceil(0.005 * SR) + 1);
  });

  it('hats are bright: most of their energy is above 5 kHz', () => {
    const x = renderDrum(new HiHat(SR));
    // A first difference boosts highs; for a bright sound it carries most of the energy.
    const d = new Float32Array(x.length - 1);
    for (let i = 1; i < x.length; i++) d[i - 1] = (x[i] as number) - (x[i - 1] as number);
    expect(rmsOf(d, 0, d.length) / rmsOf(x, 0, x.length)).toBeGreaterThan(0.9);
  });

  it('renders the same hit every time (seeded noise)', () => {
    expect(renderDrum(new Clap(SR))).toEqual(renderDrum(new Clap(SR)));
    expect(renderDrum(new Perc(SR))).toEqual(renderDrum(new Perc(SR)));
  });

  it('softClip is a bounded, odd tanh', () => {
    for (let x = -6; x <= 6; x += 0.01) {
      expect(Math.abs(softClip(x))).toBeLessThanOrEqual(1);
      expect(softClip(-x)).toBeCloseTo(-softClip(x), 12);
      expect(Math.abs(softClip(x) - Math.tanh(x))).toBeLessThan(0.025);
    }
  });
});
