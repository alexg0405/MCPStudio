import { describe, expect, it } from 'vitest';
import { TONE_BANDS } from '@core/reference/bands';
import { measureTone } from './spectrum';

const RATE = 44100;
const sine = (hz: number, seconds: number, gain = 0.5, from = 0, into?: Float32Array) => {
  const out = into ?? new Float32Array(Math.round(seconds * RATE));
  const n = into ? Math.round(seconds * RATE) : out.length;
  for (let i = 0; i < n; i++) out[from + i] = gain * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
};
const band = (id: string) => TONE_BANDS.findIndex((b) => b.id === id);

describe('measuring the tonal balance', () => {
  it('puts a tone in its band: 100 Hz in the bass, 3.5 kHz in the presence, 8 kHz in the highs', async () => {
    for (const [hz, id] of [
      [40, 'sub'],
      [100, 'bass'],
      [250, 'lowMid'],
      [700, 'mid'],
      [1800, 'upperMid'],
      [3500, 'presence'],
      [7000, 'highs'],
      [14000, 'air'],
    ] as const) {
      const x = sine(hz, 1);
      const t = await measureTone(x, x, RATE);
      const top = t.bands.indexOf(Math.max(...t.bands));
      expect(TONE_BANDS[top]!.id, `${hz} Hz`).toBe(id);
      expect(t.bands[band(id)]!, `${hz} Hz`).toBeGreaterThan(-1);
    }
  });

  it('shares add up to the whole; two equal tones in different bands share it (the bands overlap a little at their edges)', async () => {
    const x = sine(100, 1, 0.3);
    const y = sine(3500, 1, 0.3);
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + y[i]!;
    const t = await measureTone(x, x, RATE);
    const total = t.bands.reduce((n, b) => n + Math.pow(10, b / 10), 0);
    expect(total).toBeGreaterThan(0.97);
    expect(total).toBeLessThan(1.03);
    expect(t.bands[band('bass')]!).toBeGreaterThan(-4.5);
    expect(t.bands[band('presence')]!).toBeGreaterThan(-5.5);
    expect(t.bands[band('highs')]!).toBeLessThan(-12);
  });

  it('measures each span on its own, and the whole song', async () => {
    const x = new Float32Array(2 * RATE);
    sine(100, 1, 0.5, 0, x);
    sine(7000, 1, 0.5, RATE, x);
    const t = await measureTone(x, x, RATE, [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
    const top = (b: number[]) => TONE_BANDS[b.indexOf(Math.max(...b))]!.id;
    expect(top(t.sections[0]!.bands)).toBe('bass');
    expect(top(t.sections[1]!.bands)).toBe('highs');
    // The whole song has both: about 3 dB under the total each.
    expect(t.bands[band('bass')]!).toBeGreaterThan(-4.5);
    expect(t.bands[band('highs')]!).toBeGreaterThan(-4.5);
  });

  it('stereo width: 0 for mono, large when the sides differ', async () => {
    const l = sine(500, 1);
    const mono = await measureTone(l, l, RATE);
    expect(mono.width).toBeCloseTo(0, 3);
    const flipped = l.map((v) => -v);
    const wide = await measureTone(l, flipped, RATE);
    expect(wide.width).toBe(10);
    const one = await measureTone(l, new Float32Array(l.length), RATE);
    expect(one.width).toBeCloseTo(1, 1);
  });

  it('silence has the floor in every band and no width', async () => {
    const z = new Float32Array(RATE);
    const t = await measureTone(z, z, RATE, [{ start: 0, end: 1 }]);
    expect(t.bands.every((b) => b === -60)).toBe(true);
    expect(t.sections[0]!.width).toBe(0);
  });

  it('stops when asked', async () => {
    const x = sine(100, 6);
    const c = new AbortController();
    c.abort();
    await expect(measureTone(x, x, RATE, [], { signal: c.signal })).rejects.toBeTruthy();
  });
});
