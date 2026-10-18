import { describe, expect, it } from 'vitest';
import { emptyRecord, lookup, prune, readRecord, reconcile, store } from './cache';
import { SAMPLE_ANALYSIS_VERSION, type SampleAnalysis } from './types';

const a = (over: Partial<SampleAnalysis> = {}): SampleAnalysis => ({
  v: SAMPLE_ANALYSIS_VERSION,
  kind: 'one-shot',
  durationSec: 0.3,
  category: 'kick',
  confidence: 0.9,
  loudnessDb: -10,
  peakDb: -1,
  brightness: 120,
  vec: [0.1],
  ...over,
});
const file = (path: string, size = 100, lastModified = 1000) => ({ path, size, lastModified });

describe('analysis cache for a folder', () => {
  it('hits for the same path, size and time; misses when any of them changed', () => {
    const rec = emptyRecord();
    store(rec, file('Kicks/a.wav'), a());
    expect(lookup(rec, file('Kicks/a.wav'))).toEqual(a());
    expect(lookup(rec, file('Kicks/a.wav', 101))).toBeNull();
    expect(lookup(rec, file('Kicks/a.wav', 100, 1001))).toBeNull();
    expect(lookup(rec, file('Kicks/b.wav'))).toBeNull();
  });

  it('splits a folder into hits and the files still to analyze', () => {
    const rec = emptyRecord();
    store(rec, file('a.wav'), a());
    store(rec, file('b.wav'), a({ category: 'snare' }));
    const files = [file('a.wav'), file('b.wav', 5), file('c.wav')];
    const { hits, misses } = reconcile(rec, files);
    expect([...hits.keys()]).toEqual(['a.wav']);
    expect(misses.map((m) => m.path)).toEqual(['b.wav', 'c.wav']);
  });

  it('drops files that are gone when pruned, and leaves the record it was given alone', () => {
    const rec = emptyRecord();
    store(rec, file('a.wav'), a());
    store(rec, file('b.wav'), a());
    const pruned = prune(rec, [file('a.wav')]);
    expect(Object.keys(pruned.files)).toEqual(['a.wav']);
    expect(Object.keys(rec.files)).toEqual(['a.wav', 'b.wav']);
  });

  it('throws away a record of another analyzer version (a version bump re-analyzes everything)', () => {
    const rec = emptyRecord();
    store(rec, file('a.wav'), a());
    const stored = JSON.parse(JSON.stringify(rec)) as typeof rec;
    expect(Object.keys(readRecord(stored).files)).toEqual(['a.wav']);
    // The record was made by the previous version.
    expect(readRecord({ ...stored, version: SAMPLE_ANALYSIS_VERSION - 1 }).files).toEqual({});
    // One entry from an older version inside a current record.
    const mixed = { ...stored, files: { ...stored.files, 'old.wav': [1, 2, a({ v: SAMPLE_ANALYSIS_VERSION - 1 })] } };
    expect(Object.keys(readRecord(mixed).files)).toEqual(['a.wav']);
    expect(reconcile(readRecord({ ...stored, version: SAMPLE_ANALYSIS_VERSION - 1 }), [file('a.wav')]).misses).toHaveLength(1);
  });

  it('reads damaged records as empty and skips damaged entries', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { version: SAMPLE_ANALYSIS_VERSION }, { version: SAMPLE_ANALYSIS_VERSION, files: 3 }]) expect(readRecord(bad).files).toEqual({});
    const rec = readRecord({
      version: SAMPLE_ANALYSIS_VERSION,
      files: { 'ok.wav': [1, 2, a()], 'short.wav': [1, 2], 'nan.wav': ['x', 2, a()], 'null.wav': [1, 2, null], 'junk.wav': 7 },
    });
    expect(Object.keys(rec.files)).toEqual(['ok.wav']);
  });

  it('never holds a content hash (a hash in a stored value would count as audio in use for the storage clean-up)', () => {
    const rec = emptyRecord();
    store(rec, file('Kicks/a.wav', 12345, 1700000000000), a());
    expect(JSON.stringify(rec)).not.toMatch(/[0-9a-f]{64}/);
  });
});
