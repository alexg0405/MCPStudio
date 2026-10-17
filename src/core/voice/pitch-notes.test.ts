import { describe, expect, it } from 'vitest';
import { sing, type SungNote } from '../../../test/helpers/sung';
import { analyzePitch, cleanF0 } from './pitch-notes';
import { midiToHz } from './pitch';

const SR = 48000;

/** A sung line: C4 with vibrato, a legato step up a tone, a pause, a sagging E4, a short G4. */
function melody(): { x: Float32Array; seconds: number; truth: Array<{ from: number; to: number; midi: number }> } {
  const vib = (m: number, depth = 0.4, rate = 5.5) => (t: number) => m + depth * Math.sin(2 * Math.PI * rate * t);
  const seconds = 4.2;
  const glide = (a: number, b: number) => (t: number) => (t < 0.03 ? a + (b - a) * (t / 0.03) : b);
  const notes: SungNote[] = [
    { from: 0.1, to: 0.9, midi: vib(60) },
    // Legato: the next note follows at once with a short glide from the previous pitch.
    { from: 0.9, to: 1.6, midi: glide(60, 62) },
    { from: 2.0, to: 2.9, midi: (t) => 64 - 0.5 * (t / 0.9) },
    { from: 3.2, to: 3.45, midi: 67.2 },
  ];
  return {
    x: sing(notes, SR, seconds),
    seconds,
    truth: [
      { from: 0.1, to: 0.9, midi: 60 },
      { from: 0.9, to: 1.6, midi: 62 },
      { from: 2.0, to: 2.9, midi: 63.75 },
      { from: 3.2, to: 3.45, midi: 67.2 },
    ],
  };
}

describe('analyzePitch', () => {
  it('cuts a sung line into its notes with their pitch', () => {
    const { x, truth } = melody();
    const a = analyzePitch(x, SR);
    expect(a.notes.length).toBe(truth.length);
    a.notes.forEach((n, i) => {
      const t = truth[i]!;
      expect(Math.abs(n.from - t.from), `note ${i} start`).toBeLessThan(0.05);
      expect(Math.abs(n.to - t.to), `note ${i} end`).toBeLessThan(0.05);
      expect(Math.abs(n.pitch - t.midi), `note ${i} pitch`).toBeLessThan(0.15);
    });
  });

  it('measures vibrato and drift', () => {
    const { x } = melody();
    const [first, second, sag] = analyzePitch(x, SR).notes;
    // ±40 cents at 5.5 Hz: about 80 cents peak to peak.
    expect(first!.vibratoRate).toBeGreaterThan(4.8);
    expect(first!.vibratoRate).toBeLessThan(6.2);
    expect(first!.vibratoDepth).toBeGreaterThan(55);
    expect(first!.vibratoDepth).toBeLessThan(100);
    expect(second!.vibratoDepth).toBe(0);
    // The sagging note falls 50 cents over its length; the steady ones do not move.
    expect(sag!.drift).toBeGreaterThan(30);
    expect(sag!.drift).toBeLessThan(70);
    expect(second!.drift).toBeLessThan(15);
  });

  it('puts the frames on the recording’s timeline (start offset)', () => {
    const { x } = melody();
    const a = analyzePitch(x, SR, { start: 10 });
    expect(a.t0).toBe(10);
    expect(a.notes[0]!.from).toBeGreaterThan(10.05);
    expect(a.notes[0]!.from).toBeLessThan(10.2);
    expect(a.hop).toBeCloseTo(0.005, 6);
  });

  it('finds nothing in silence or noise', () => {
    expect(analyzePitch(new Float32Array(SR), SR).notes).toEqual([]);
    let s = 7;
    const noise = Float32Array.from({ length: SR }, () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 2 ** 32 - 0.5) * 0.4;
    });
    expect(analyzePitch(noise, SR).notes.length).toBe(0);
  });

  it('is deterministic', () => {
    const { x } = melody();
    expect(JSON.stringify(analyzePitch(x, SR).notes)).toBe(JSON.stringify(analyzePitch(x, SR).notes));
  });
});

describe('cleanF0', () => {
  it('moves an octave slip back, drops a lone outlier, bridges a dropout, drops tiny runs', () => {
    const f = midiToHz(60);
    const f0 = new Float32Array(40).fill(f);
    f0[10] = f * 2; // octave slip
    f0[20] = f * 1.5; // outlier
    f0[30] = 0;
    f0[31] = 0; // two-frame dropout
    const conf = new Float32Array(40).fill(0.9);
    const out = cleanF0(f0, conf).f0;
    expect(out[10]).toBeCloseTo(f, 1);
    expect(out[30]).toBeGreaterThan(0);
    expect(out[31]).toBeGreaterThan(0);
    const tiny = new Float32Array(20);
    tiny[5] = f;
    tiny[6] = f;
    expect(Array.from(cleanF0(tiny, new Float32Array(20).fill(0.9)).f0).every((v) => v === 0)).toBe(true);
    // The outlier did not survive as a wrong pitch.
    expect(out[20] === 0 || Math.abs(1200 * Math.log2(out[20]! / f)) < 50).toBe(true);
  });
});
