import { describe, expect, it } from 'vitest';
import type { SampleRef, SampleId } from '@core/model/types';
import { renderTestSong, PATTERNS, chord, MINOR, MAJOR } from '@core/dj/test-songs';
import { ANALYSIS_VERSION, type TrackAnalysis } from '@core/dj/types';
import type { Services } from '../services';
import { analysisHash, createTrackAnalyzer, inlineRunner, memoryAnalysisStorage, type AnalysisDecoder, type AnalysisRunner } from './analysis-cache';
import { loudness } from './analysis-run';
import { driveAnalysis, inlineStreamTarget, type StreamSource } from './analysis-stream-run';

const ref = (hash: string): SampleRef => ({
  id: `s-${hash}` as SampleId,
  name: `${hash}.wav`,
  source: { kind: 'embedded', hash, ext: 'wav' },
});
const s = {} as Services;

/** A 16-bar 122 BPM song in A minor at 44.1 kHz stereo. */
function song() {
  const t = renderTestSong({
    sampleRate: 44100,
    bpm: 122,
    offset: 0.6,
    pattern: PATTERNS.house,
    chords: [chord(57, MINOR), chord(50, MINOR), chord(52, MAJOR), chord(57, MINOR)],
    parts: [{ bars: 16, kick: true, snare: true, hats: true, bass: true, pads: true }],
  });
  return t;
}

function decoder() {
  const calls: string[] = [];
  const t = song();
  const decode: AnalysisDecoder = (_s, r) => {
    calls.push(analysisHash(r));
    return Promise.resolve({ channels: [t.mono.slice(), t.mono.slice()], sampleRate: 44100 });
  };
  return { decode, calls, song: t };
}

describe('track analyzer', () => {
  it('analyzes once, caches, persists and notifies', async () => {
    const storage = memoryAnalysisStorage();
    const { decode, calls, song: t } = decoder();
    const an = createTrackAnalyzer({ storage, decode, run: inlineRunner });
    let notified = 0;
    an.subscribe(() => notified++);
    expect(an.peek('abc')).toBeNull();
    const progress: number[] = [];
    const a = await an.analyze(s, ref('abc'), { onProgress: (p) => progress.push(p.fraction) });
    expect(a.version).toBe(ANALYSIS_VERSION);
    expect(a.hash).toBe('abc');
    expect(a.grid?.bpm).toBe(122);
    expect(Math.abs(a.grid!.firstDownbeat - t.downbeats[0]!)).toBeLessThan(0.02);
    expect(a.key?.camelot).toBe('8A');
    expect(Number.isFinite(a.lufs)).toBe(true);
    expect(a.truePeakDb).toBeLessThan(0.5);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1]!)).toBe(true);
    expect(notified).toBe(1);
    expect(an.peek('abc')).toBe(a);
    expect(storage.items.get('abc')?.grid?.bpm).toBe(122);
    // Cached: no second decode.
    expect(await an.analyze(s, ref('abc'))).toBe(a);
    expect(calls).toEqual(['abc']);
    // A new session reads it back.
    const again = createTrackAnalyzer({ storage, decode, run: inlineRunner });
    await again.ready;
    expect(again.peek('abc')?.grid?.bpm).toBe(122);
  });

  it('ignores stored analyses of another version', async () => {
    const old = { version: ANALYSIS_VERSION - 1, hash: 'old', energy: [], sections: [] } as unknown as TrackAnalysis;
    const storage = memoryAnalysisStorage([old]);
    const an = createTrackAnalyzer({ storage, decode: decoder().decode, run: inlineRunner });
    await an.ready;
    expect(an.peek('old')).toBeNull();
  });

  it('shares a job between callers and cancels it when all of them abort', async () => {
    const { decode, calls } = decoder();
    let runs = 0;
    let sawAbort = false;
    const run: AnalysisRunner = (job, p, signal) => {
      runs++;
      signal.addEventListener('abort', () => (sawAbort = true));
      return inlineRunner(job, p, signal);
    };
    const an = createTrackAnalyzer({ storage: memoryAnalysisStorage(), decode, run });
    const c1 = new AbortController();
    const first = an.analyze(s, ref('x'), { signal: c1.signal });
    const second = an.analyze(s, ref('x'));
    c1.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const a = await second;
    expect(a.hash).toBe('x');
    expect(calls).toEqual(['x']);
    expect(runs).toBe(1);
    expect(sawAbort).toBe(false);

    // Everyone gives up: the job stops.
    const c2 = new AbortController();
    const lone = an.analyze(s, ref('y'), { signal: c2.signal });
    c2.abort();
    await expect(lone).rejects.toMatchObject({ name: 'AbortError' });
    expect(an.peek('y')).toBeNull();
    // Asking again starts over and works.
    expect((await an.analyze(s, ref('y'))).hash).toBe('y');
  });

  it('analyzes a song too long to decode whole by parts, never decoding it, and caches it like any other', async () => {
    const storage = memoryAnalysisStorage();
    const { decode, calls } = decoder();
    const t = song();
    const l = t.mono;
    let disposed = 0;
    const source: StreamSource = {
      nativeFrames: l.length,
      nativeRate: 44100,
      channels: 1,
      readNative: (start, n, outL, outR) => {
        for (let i = 0; i < n; i++) outL[i] = outR[i] = l[start + i] ?? 0;
        return Promise.resolve();
      },
      dispose: () => void disposed++,
    };
    const opened: string[] = [];
    const an = createTrackAnalyzer({
      storage,
      decode,
      run: inlineRunner,
      openStream: (_s, r) => {
        opened.push(analysisHash(r));
        return Promise.resolve(source);
      },
      runStream: (hash, src, onProgress, signal) => driveAnalysis(hash, src, inlineStreamTarget({ signal, yieldNow: () => Promise.resolve() }), { signal, onProgress }),
    });
    const progress: number[] = [];
    const a = await an.analyze(s, ref('long'), { onProgress: (p) => progress.push(p.fraction) });
    expect(a.hash).toBe('long');
    expect(a.grid?.bpm).toBe(122);
    expect(Math.abs(a.grid!.firstDownbeat - t.downbeats[0]!)).toBeLessThan(0.02);
    expect(a.key?.camelot).toBe('8A');
    expect(calls).toEqual([]);
    expect(opened).toEqual(['long']);
    expect(disposed).toBe(1);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1]!)).toBe(true);
    expect(storage.items.get('long')?.grid?.bpm).toBe(122);
    expect(await an.analyze(s, ref('long'))).toBe(a);
    expect(opened).toEqual(['long']);
    // A song that can't be read by parts (the opener says null) is decoded whole as before.
    const plain = createTrackAnalyzer({ storage: memoryAnalysisStorage(), decode, run: inlineRunner, openStream: () => Promise.resolve(null) });
    expect((await plain.analyze(s, ref('short'))).grid?.bpm).toBe(122);
    expect(calls).toEqual(['short']);
  });

  it('refuses a long file that can’t be read by parts instead of decoding hours of floats', async () => {
    const { decode, calls } = decoder();
    const an = createTrackAnalyzer({ storage: memoryAnalysisStorage(), decode, run: inlineRunner, openStream: () => Promise.resolve(null) });
    await expect(an.analyze(s, { ...ref('flac'), durationSec: 3 * 3600 })).rejects.toThrow(/MP3 or WAV/);
    expect(calls).toEqual([]);
  });

  it('cancelling a song analyzed by parts stops reading it and frees the file', async () => {
    const t = song();
    let reads = 0;
    let disposed = 0;
    const source: StreamSource = {
      nativeFrames: t.mono.length * 4,
      nativeRate: 44100,
      channels: 1,
      readNative: async (_start, n, outL, outR) => {
        reads++;
        outL.fill(0.1, 0, n);
        outR.fill(0.1, 0, n);
      },
      dispose: () => void disposed++,
    };
    const an = createTrackAnalyzer({
      storage: memoryAnalysisStorage(),
      decode: decoder().decode,
      run: inlineRunner,
      openStream: () => Promise.resolve(source),
      runStream: (hash, src, onProgress, signal) => driveAnalysis(hash, src, inlineStreamTarget({ signal, yieldNow: () => Promise.resolve() }), { signal, onProgress, chunkFrames: 50000 }),
    });
    const c = new AbortController();
    const p = an.analyze(s, ref('z'), { signal: c.signal, onProgress: (x) => x.fraction > 0.05 && c.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 20));
    expect(disposed).toBe(1);
    const seen = reads;
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(seen);
    expect(an.peek('z')).toBeNull();
  });

  it('names built-in sounds by generator', () => {
    expect(analysisHash({ source: { kind: 'builtin', generator: 'kit/kick', version: 2 } })).toBe('builtin:kit/kick@2');
  });
});

describe('loudness for analysis', () => {
  it('measures a −6 dBFS stereo sine at −6 LUFS and its true peak', () => {
    const sr = 44100;
    const n = sr * 5;
    const x = new Float32Array(n);
    // 1 kHz with a phase that puts no sample on the crests.
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr + 0.3);
    const m = loudness([x, x], sr);
    expect(m.lufs).toBeCloseTo(-6.02, 0);
    expect(Math.abs(m.truePeakDb - -6.02)).toBeLessThan(0.1);
  });
});
