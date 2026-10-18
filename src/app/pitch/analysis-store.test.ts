import { describe, expect, it } from 'vitest';
import { PITCH_ANALYSIS_VERSION, type PitchAnalysis } from '@core/voice/pitch-notes';
import { memoryKv } from '../storage/kv';
import { createPitchAnalysisStore, isStoredAnalysis, pitchAnalysisKey, PITCH_ANALYSIS_LIMIT } from './analysis-store';

const HASH = 'a'.repeat(64);
const analysis = (n = 3): PitchAnalysis => ({
  t0: 1.5,
  hop: 0.005,
  f0: Float32Array.from({ length: n }, (_, i) => 220 + i),
  conf: Float32Array.from({ length: n }, () => 0.9),
  notes: [{ from: 1.5, to: 1.6, pitch: 57.1, drift: 3, vibratoDepth: 0, vibratoRate: 0 }],
});

describe('pitch analysis store', () => {
  it('the key names version, rate, range and ends in the hash (the collector finds the hash last)', () => {
    expect(pitchAnalysisKey(HASH, 48000, 0.25, 3.5)).toBe(`pitch-analysis:v${PITCH_ANALYSIS_VERSION}:48000:0.25:3.50:${HASH}`);
    const key = pitchAnalysisKey(HASH, 44100, 1, 2);
    expect(key.slice(key.lastIndexOf(':') + 1)).toBe(HASH);
  });

  it('round-trips an analysis with its typed arrays', async () => {
    const store = createPitchAnalysisStore(memoryKv());
    const key = pitchAnalysisKey(HASH, 48000, 0, 1);
    expect(await store.get(key)).toBeNull();
    await store.set(key, analysis());
    const back = await store.get(key);
    expect(back?.f0).toBeInstanceOf(Float32Array);
    expect(Array.from(back!.f0)).toEqual(Array.from(analysis().f0));
    expect(back?.notes[0]?.pitch).toBe(57.1);
    expect(back?.t0).toBe(1.5);
  });

  it('ignores damaged entries and other versions', async () => {
    const kv = memoryKv();
    const store = createPitchAnalysisStore(kv);
    const key = pitchAnalysisKey(HASH, 48000, 0, 1);
    kv.data.set(key, { version: PITCH_ANALYSIS_VERSION, at: 1, analysis: { t0: 0, hop: 0.005, f0: [1, 2], conf: [1], notes: [] } });
    expect(await store.get(key)).toBeNull();
    kv.data.set(key, { version: PITCH_ANALYSIS_VERSION - 1, at: 1, analysis: analysis() });
    expect(await store.get(key)).toBeNull();
    expect(isStoredAnalysis(null)).toBe(false);
    expect(isStoredAnalysis({ version: PITCH_ANALYSIS_VERSION, at: 1, analysis: { ...analysis(), notes: [{ from: 'x' }] } })).toBe(false);
  });

  it('keeps the newest entries and drops older versions once', async () => {
    const kv = memoryKv();
    kv.data.set(`pitch-analysis:v0:48000:0.00:1.00:${'b'.repeat(64)}`, { version: 0 });
    const store = createPitchAnalysisStore(kv, 3);
    let t = 1000;
    const real = Date.now;
    Date.now = () => (t += 10);
    try {
      for (let i = 0; i < 5; i++) await store.set(pitchAnalysisKey(String(i).repeat(64), 48000, 0, 1), analysis());
    } finally {
      Date.now = real;
    }
    const keys = [...kv.data.keys()].sort();
    expect(keys.length).toBe(3);
    // The three newest hashes.
    expect(keys.map((k) => k.slice(-64)[0])).toEqual(['2', '3', '4']);
    expect(keys.some((k) => k.includes(':v0:'))).toBe(false);
  });

  it('a store that throws is a cache miss, never an error', async () => {
    const kv = memoryKv();
    kv.getMany = () => Promise.reject(new Error('x'));
    kv.set = () => Promise.reject(new Error('x'));
    const store = createPitchAnalysisStore(kv);
    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.set('k', analysis())).resolves.toBeUndefined();
    expect(PITCH_ANALYSIS_LIMIT).toBeGreaterThan(8);
  });
});
