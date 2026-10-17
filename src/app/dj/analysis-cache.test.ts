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

/** A stand-in analysis: the queue tests are about order and sharing, not about what is measured. */
const fakeAnalysis = (hash: string) => ({ version: ANALYSIS_VERSION, hash, energy: [], sections: [] }) as unknown as TrackAnalysis;

/** Lets the analyzer take the steps it can (its steps are promises, so one macrotask runs them all). */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A runner that records the order songs start in, and holds each one until the test finishes it: the test decides when the
 * running job ends, so what runs next is visible. No audio: the decoder is a fake too.
 */
function queueFixture() {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  const run: AnalysisRunner = (job, _onProgress, signal) =>
    new Promise<TrackAnalysis>((resolve, reject) => {
      started.push(job.hash);
      finishers.set(job.hash, () => resolve(fakeAnalysis(job.hash)));
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    });
  const decode: AnalysisDecoder = () => Promise.resolve({ channels: [new Float32Array(1)], sampleRate: 44100 });
  const an = createTrackAnalyzer({ storage: memoryAnalysisStorage(), decode, run, openStream: () => Promise.resolve(null) });
  /** Finishes a song that has started, then lets the analyzer start the next one. */
  const finish = async (hash: string) => {
    const done = finishers.get(hash);
    if (!done) throw new Error(`${hash} has not started`);
    finishers.delete(hash);
    done();
    await settle();
  };
  return { an, started, finish };
}

describe('analysis queue', () => {
  it('runs a now job second, after the running one and ahead of the queued background jobs', async () => {
    const { an, started, finish } = queueFixture();
    const background = ['b1', 'b2', 'b3'].map((h) => an.analyze(s, ref(h)));
    const now = an.analyze(s, ref('n'), { priority: 'now' });
    await settle();
    expect(started).toEqual(['b1']);
    await finish('b1');
    expect(started).toEqual(['b1', 'n']);
    await finish('n');
    expect(started).toEqual(['b1', 'n', 'b2']);
    await finish('b2');
    await finish('b3');
    expect((await now).hash).toBe('n');
    expect((await Promise.all(background)).map((a) => a.hash)).toEqual(['b1', 'b2', 'b3']);
  });

  it('runs jobs of one priority first in first out', async () => {
    const { an, started, finish } = queueFixture();
    const all = [
      an.analyze(s, ref('r')),
      an.analyze(s, ref('a')),
      an.analyze(s, ref('b')),
      an.analyze(s, ref('c')),
      an.analyze(s, ref('n1'), { priority: 'now' }),
      an.analyze(s, ref('n2'), { priority: 'now' }),
    ];
    await settle();
    for (const h of ['r', 'n1', 'n2', 'a', 'b', 'c']) await finish(h);
    expect(started).toEqual(['r', 'n1', 'n2', 'a', 'b', 'c']);
    expect((await Promise.all(all)).map((a) => a.hash)).toEqual(['r', 'a', 'b', 'c', 'n1', 'n2']);
  });

  it('callers asking for the same song share one job, while it runs or is queued', async () => {
    const { an, started, finish } = queueFixture();
    const first = an.analyze(s, ref('r'));
    const second = an.analyze(s, ref('r'), { priority: 'now' });
    const queued1 = an.analyze(s, ref('q'));
    const queued2 = an.analyze(s, ref('q'));
    await settle();
    expect(started).toEqual(['r']);
    await finish('r');
    expect(await second).toBe(await first);
    await finish('q');
    expect(started).toEqual(['r', 'q']);
    expect(await queued2).toBe(await queued1);
  });

  it('a now request moves a queued background job of the same song up, and it stays queued for the caller still waiting', async () => {
    const { an, started, finish } = queueFixture();
    const r = an.analyze(s, ref('r'));
    const a = an.analyze(s, ref('a'));
    const bFirst = an.analyze(s, ref('b'));
    const c = new AbortController();
    const bLeaves = an.analyze(s, ref('b'), { signal: c.signal });
    const bNow = an.analyze(s, ref('b'), { priority: 'now' });
    c.abort();
    await expect(bLeaves).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(started).toEqual(['r']);
    await finish('r');
    // The promoted song goes before 'a', which was queued before it at background priority.
    expect(started).toEqual(['r', 'b']);
    await finish('b');
    expect(started).toEqual(['r', 'b', 'a']);
    await finish('a');
    expect((await bFirst).hash).toBe('b');
    expect((await bNow).hash).toBe('b');
    expect((await a).hash).toBe('a');
    expect((await r).hash).toBe('r');
  });

  it('cancelling a queued job takes it out of the queue, and asking for it again queues it anew', async () => {
    const { an, started, finish } = queueFixture();
    const r = an.analyze(s, ref('r'));
    const c = new AbortController();
    const gone = an.analyze(s, ref('x'), { signal: c.signal });
    const y = an.analyze(s, ref('y'));
    c.abort();
    await expect(gone).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    await finish('r');
    expect(started).toEqual(['r', 'y']);
    await finish('y');
    expect(started).toEqual(['r', 'y']);
    const again = an.analyze(s, ref('x'));
    await settle();
    await finish('x');
    expect((await again).hash).toBe('x');
    expect((await r).hash).toBe('r');
    expect((await y).hash).toBe('y');
    expect(started).toEqual(['r', 'y', 'x']);
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
