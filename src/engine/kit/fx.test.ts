import { describe, expect, it } from 'vitest';
import { FX_KINDS, fxBeats, fxLabel, fxName, fxSampleRef, fxSeconds, parseFxName, type FxKind } from '@core/model/fx';
import { generateFx } from './fx';

const SR = 48000;

const rmsDb = (ch: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += ch[i]! * ch[i]!;
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20);
};

const peakAt = (chs: Float32Array[]) => {
  let best = 0;
  let at = 0;
  for (const ch of chs)
    for (let i = 0; i < ch.length; i++)
      if (Math.abs(ch[i]!) > best) {
        best = Math.abs(ch[i]!);
        at = i;
      }
  return { peak: best, at };
};

function hash(chs: Float32Array[]): number {
  let h = 2166136261;
  for (const ch of chs) {
    const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength);
    for (let i = 0; i < bytes.length; i += 5) h = Math.imul(h ^ bytes[i]!, 16777619);
  }
  return h >>> 0;
}

describe('FX sample names', () => {
  it('round-trips names and refuses others', () => {
    expect(fxName('riser', 16, 150)).toBe('fx/riser/16b@150');
    expect(parseFxName('fx/riser/16b@150')).toEqual({ kind: 'riser', beats: 16, bpm: 150 });
    expect(parseFxName(fxName('reverse-crash', 2, 123.5))).toEqual({ kind: 'reverse-crash', beats: 2, bpm: 123.5 });
    for (const bad of ['fx/laser/4b@120', 'kit/kick', 'fx/riser/4b', 'fx/riser/0b@120', 'fx/riser/4b@5']) expect(parseFxName(bad)).toBeNull();
    expect(fxSeconds({ kind: 'riser', beats: 16, bpm: 150 })).toBeCloseTo(6.4, 9);
  });

  it('hits last about their own time at any tempo; the rest as long as asked', () => {
    expect(fxBeats('impact', 150)).toBe(9);
    expect(fxBeats('sub-drop', 150)).toBe(6);
    expect(fxBeats('impact', 75)).toBe(4);
    expect(fxBeats('riser', 150, 16)).toBe(16);
    expect(fxLabel('riser', 16)).toBe('Riser · 4 bars');
    expect(fxLabel('reverse-crash', 2)).toBe('Reverse crash · 2 beats');
    expect(fxLabel('impact', 9)).toBe('Impact');
    const ref = fxSampleRef('riser', 8, 90);
    expect(ref.source).toEqual({ kind: 'builtin', generator: 'fx/riser/8b@90', version: 1 });
    expect(ref.durationSec).toBeCloseTo(8 * (60 / 90), 9);
  });
});

describe('FX sounds', () => {
  const lengths: Record<FxKind, number> = { riser: 16, downlifter: 4, 'reverse-crash': 4, whoosh: 2, impact: 9, 'sub-drop': 6 };
  for (const kind of FX_KINDS) {
    it(`${kind}: as long as its name says, finite, under full scale, deterministic`, () => {
      const name = fxName(kind, lengths[kind], 150);
      const a = generateFx(name, SR)!;
      const b = generateFx(name, SR)!;
      expect(a).toHaveLength(2);
      expect(a[0]!.length).toBe(Math.round(((lengths[kind] * 60) / 150) * SR));
      for (const ch of a) for (let i = 0; i < ch.length; i += 7) expect(Number.isFinite(ch[i]!)).toBe(true);
      const { peak } = peakAt(a);
      expect(peak).toBeGreaterThan(0.5);
      expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
      expect(hash(a)).toBe(hash(b));
      // Another tempo is another sound of another length.
      expect(generateFx(fxName(kind, lengths[kind], 90), SR)![0]!.length).toBe(Math.round(((lengths[kind] * 60) / 90) * SR));
    });
  }

  it('a riser swells: its last 10% is at least 12 dB above its first 10%', () => {
    for (const bpm of [150, 124, 90, 75]) {
      const [l] = generateFx(fxName('riser', 16, bpm), SR)!;
      const n = l!.length;
      expect(rmsDb(l!, Math.round(0.9 * n), n) - rmsDb(l!, 0, Math.round(0.1 * n))).toBeGreaterThanOrEqual(12);
    }
  });

  it('a reverse crash peaks in its last 3%, an impact within 50 ms', () => {
    const rc = generateFx(fxName('reverse-crash', 4, 150), SR)!;
    expect(peakAt(rc).at).toBeGreaterThanOrEqual(0.97 * rc[0]!.length);
    const im = generateFx(fxName('impact', 9, 150), SR)!;
    expect(peakAt(im).at).toBeLessThan(0.05 * SR);
  });

  it('a downlifter fades out and a sub drop is all low end', () => {
    const [d] = generateFx(fxName('downlifter', 4, 150), SR)!;
    const n = d!.length;
    expect(rmsDb(d!, 0, Math.round(0.1 * n)) - rmsDb(d!, Math.round(0.85 * n), Math.round(0.95 * n))).toBeGreaterThan(20);
    const [s] = generateFx(fxName('sub-drop', 6, 150), SR)!;
    // Zero crossings of a sub-bass sine: well under 100 per second.
    let crossings = 0;
    for (let i = 1; i < SR; i++) if (s![i - 1]! < 0 !== s![i]! < 0) crossings++;
    expect(crossings).toBeLessThan(140);
  });

  it('ignores names that are not FX', () => {
    expect(generateFx('kit/kick', SR)).toBeNull();
  });
});
