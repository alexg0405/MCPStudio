import { describe, expect, it } from 'vitest';
import { PATTERNS, renderTestSong } from '../dj/test-songs';
import { detectTempo, detectTransients } from './transients';

const SR = 48000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decaying noise bursts (drum-like hits) at `times`, over quiet noise. */
function hits(times: number[], seconds: number, levels: number[] = []): Float32Array {
  const r = rng(3);
  const x = new Float32Array(Math.round(seconds * SR)).map(() => 0.002 * (r() - 0.5));
  times.forEach((t, k) => {
    const at = Math.round(t * SR);
    const level = levels[k] ?? 0.8;
    for (let i = 0; i < 0.12 * SR && at + i < x.length; i++)
      x[at + i] = (x[at + i] as number) + level * Math.exp(-i / (0.025 * SR)) * (r() * 2 - 1);
  });
  return x;
}

describe('transient detection', () => {
  it('finds each hit just before its attack', () => {
    const times = [0.1, 0.35, 0.6, 0.95, 1.2, 1.31];
    const found = detectTransients([hits(times, 1.6, [0.8, 0.3, 0.9, 0.5, 0.7, 0.6])], SR);
    expect(found).toHaveLength(times.length);
    found.forEach((t, i) => {
      expect(t - times[i]!).toBeGreaterThan(-0.006);
      expect(t - times[i]!).toBeLessThan(0.003);
    });
  });

  it('ignores a held tone, finds where a note starts, and honours the range and the minimum gap', () => {
    const x = new Float32Array(2 * SR);
    for (let i = Math.round(0.5 * SR); i < x.length; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const found = detectTransients([x], SR);
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0]! - 0.5)).toBeLessThan(0.006);
    const h = hits([0.1, 0.5, 0.53, 0.9], 1.2);
    expect(detectTransients([h], SR, { from: 0.3, to: 0.8 }).map((t) => Math.round(t * 10) / 10)).toEqual([0.5]);
    expect(detectTransients([h], SR, { minGap: 0.01 })).toHaveLength(4);
  });

  it('finds softer hits at a higher sensitivity', () => {
    const h = hits([0.2, 0.6, 1.0], 1.3, [0.8, 0.02, 0.8]);
    expect(detectTransients([h], SR, { sensitivity: 0.1 })).toHaveLength(2);
    expect(detectTransients([h], SR, { sensitivity: 1 })).toHaveLength(3);
  });
});

describe('tempo detection', () => {
  it('reads the tempo of a beat, exactly when the loop is whole bars', () => {
    const beat = (bpm: number, bars: number) => {
      const t: number[] = [];
      for (let b = 0; b < bars * 4; b++) t.push((b * 60) / bpm);
      return hits(t, (bars * 4 * 60) / bpm);
    };
    expect(detectTempo([beat(120, 4)], SR)).toBe(120);
    expect(detectTempo([beat(128, 4)], SR)).toBe(128);
    expect(detectTempo([beat(93, 2)], SR)).toBe(93);
  });

  it('says nothing for a one-shot', () => {
    expect(detectTempo([hits([0.05], 2.5)], SR)).toBeNull();
  });

  it('prefers the main pulse over eighth-note hats', () => {
    const bpm = 100;
    const t: number[] = [];
    const levels: number[] = [];
    for (let e = 0; e < 32; e++) {
      t.push((e * 30) / bpm);
      levels.push(e % 2 ? 0.25 : 0.9);
    }
    expect(detectTempo([hits(t, (32 * 30) / bpm, levels)], SR)).toBe(100);
  });

  it('reads a house loop as its tempo, not as the 2/3 pulse its bass pattern repeats at (124 gave 82.7, 128 at 44.1 kHz gave 85.4)', () => {
    for (const [bpm, rate] of [[124, 44100], [128, 44100], [140, 48000]] as const) {
      const song = renderTestSong({ sampleRate: rate, bpm, offset: 0, tail: 0, pattern: PATTERNS.house, parts: [{ bars: 4, kick: true, snare: true, hats: true, bass: true, pads: true }] });
      expect(detectTempo([song.mono], rate, { beatsPerBar: 4 }), `${bpm} BPM at ${rate} Hz`).toBe(bpm);
    }
  });
});
