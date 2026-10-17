import { describe, expect, it } from 'vitest';
import { Decimator, decimate } from '@core/voice/filters';
import { chromagram, ChromaLevel, ChromaStream } from '@core/dj/chroma';
import { onsetFeatures, OnsetStream, signalRms } from '@core/dj/onset';
import { analysisFactor, AnalysisFront, LevelScan, planScanRegions } from '@core/dj/stream-features';
import { PATTERNS, chord, MINOR, MAJOR, renderTestSong, type SongPart, type TestSongSpec } from '@core/dj/test-songs';
import type { TrackAnalysis } from '@core/dj/types';
import { decodePcm, encodeWav } from '@core/io/wav';
import { byteReaderOf } from '@core/io/audio-segments';
import { openSegmentSource } from '@engine/deck/deck-source';
import { loudness, runAnalysis, LoudnessStream } from './analysis-run';
import { driveAnalysis, inlineStreamTarget, type StreamSource } from './analysis-stream-run';

const SR = 44100;
const noYield = () => Promise.resolve();

/** A song with an intro, two bodies around a break and an outro (`bars` 1: 56 bars; 0.5: 28): stereo at 44.1 kHz (the right channel is a quieter copy with its own noise). */
function stereoSong(spec: Partial<TestSongSpec> = {}, bars = 1): { l: Float32Array; r: Float32Array; downbeats: number[]; bpm: number } {
  const bpm = spec.bpm ?? 122;
  const full: Omit<SongPart, 'bars'> = { kick: true, snare: true, hats: true, bass: true, pads: true };
  const song = renderTestSong({
    sampleRate: SR,
    bpm,
    offset: 0.6,
    pattern: PATTERNS.house,
    chords: [chord(57, MINOR), chord(50, MINOR), chord(52, MAJOR), chord(57, MINOR)],
    parts: [
      { bars: 8 * bars, kick: true, hats: true, level: 0.7 },
      { bars: 16 * bars, ...full },
      { bars: 8 * bars, pads: true, level: 0.6 },
      { bars: 16 * bars, ...full },
      { bars: 8 * bars, kick: true, hats: true, level: 0.6 },
    ],
    ...spec,
  });
  const l = song.mono;
  const r = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) r[i] = 0.8 * l[i]! + 0.02 * Math.sin(i * 0.37);
  return { l, r, downbeats: song.downbeats, bpm };
}

/** A song read by parts from arrays. */
function arraySource(l: Float32Array, r: Float32Array | null, rate = SR): StreamSource {
  return {
    nativeFrames: l.length,
    nativeRate: rate,
    channels: r ? 2 : 1,
    readNative: (start, n, outL, outR) => {
      for (let i = 0; i < n; i++) {
        outL[i] = l[start + i] ?? 0;
        outR[i] = (r ?? l)[start + i] ?? 0;
      }
      return Promise.resolve();
    },
    dispose: () => {},
  };
}

async function streamed(src: StreamSource, opts: Parameters<typeof driveAnalysis>[3] = {}): Promise<TrackAnalysis> {
  return driveAnalysis('h', src, inlineStreamTarget({ yieldNow: noYield }), opts);
}

/** Same length and every value equal (a fast stand-in for `toEqual`, which is slow on millions of floats). */
function expectSame(a: Float32Array, b: Float32Array): void {
  expect(a.length).toBe(b.length);
  let first = -1;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) {
      first = i;
      break;
    }
  expect(first).toBe(-1);
}

/** In pieces of odd sizes. */
function feed(x: Float32Array, push: (piece: Float32Array) => void, sizes = [1, 777, 4099, 65537, 12345]): void {
  for (let o = 0, k = 0; o < x.length; k++) {
    const n = Math.min(sizes[k % sizes.length]!, x.length - o);
    push(x.subarray(o, o + n));
    o += n;
  }
}

describe('the streaming stages equal the whole-signal ones', () => {
  const song = stereoSong();
  const mono22 = decimate(song.l, 2, SR);

  it('a decimator fed in pieces is `decimate`', () => {
    const whole = decimate(song.l, 4, SR);
    const d = new Decimator(4, SR);
    const out: number[] = [];
    const buf = new Float32Array(100000);
    feed(song.l, (p) => {
      const n = d.process(p, buf);
      for (let i = 0; i < n; i++) out.push(buf[i]!);
    });
    expect(out.length).toBe(whole.length);
    expectSame(Float32Array.from(out), whole);
  });

  it('onset features and chroma, fed in odd pieces, are bit for bit what the whole signal gives', () => {
    const rate = SR / 2;
    const whole = onsetFeatures(mono22, rate);
    const o = new OnsetStream(rate, signalRms(mono22), 0);
    feed(mono22, (p) => o.push(p));
    const got = o.finish();
    for (const k of ['onset', 'low', 'lowMid', 'highMid', 'high', 'power', 'lowPower'] as const) expectSame(got[k], whole[k]);

    const c = chromagram(mono22, rate);
    const level = new ChromaLevel(rate);
    feed(mono22, (p) => level.push(p));
    const cs = new ChromaStream(rate, level.rms, mono22.length);
    feed(mono22, (p) => cs.push(p));
    const cg = cs.finish();
    expect(cg.frames).toBe(c.frames);
    expect(cg.tuningCents).toBe(c.tuningCents);
    expectSame(cg.treble, c.treble);
    expectSame(cg.bass, c.bass);
    expectSame(cg.energy, c.energy);
  }, 60_000);

  it('the front end makes the mono analysis signal the whole-file code makes', () => {
    const front = new AnalysisFront(SR);
    expect(front.factor).toBe(analysisFactor(SR));
    const out: number[] = [];
    let at = 0;
    feed(song.l, (p) => {
      const m = front.push(p, song.r.subarray(at, at + p.length));
      at += p.length;
      for (let i = 0; i < m.length; i++) out.push(m[i]!);
    });
    const mono = new Float32Array(song.l.length);
    for (let i = 0; i < mono.length; i++) mono[i] = song.l[i]! + song.r[i]!;
    for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! / 2;
    expectSame(Float32Array.from(out), decimate(mono, 2, SR));
  });

  it('plans the level scan over the whole song when short, else regions spread over it', () => {
    expect(planScanRegions(100 * SR, SR)).toEqual([{ start: 0, frames: 100 * SR }]);
    expect(planScanRegions(0, SR)).toEqual([]);
    const long = 7200 * SR;
    const r = planScanRegions(long, SR);
    expect(r.length).toBe(30);
    expect(r[0]!.start).toBeGreaterThanOrEqual(0);
    expect(r[29]!.start + r[29]!.frames).toBeLessThanOrEqual(long);
    expect(r.reduce((a, g) => a + g.frames, 0) / SR).toBe(600);
    expect(r.every((g, i) => i === 0 || g.start > r[i - 1]!.start + g.frames)).toBe(true);
  });

  it('the level scan over the whole song is the signal’s own level', () => {
    const scan = new LevelScan(SR);
    feed(song.l, (p) => scan.push(p, null));
    const lv = scan.result();
    expect(lv.onsetRms).toBe(signalRms(mono22));
    const level = new ChromaLevel(SR / 2);
    level.push(mono22);
    expect(lv.chromaRms).toBe(level.rms);
  });
});

describe('streaming loudness', () => {
  it('matches the whole-file measurement (integrated loudness exactly, true peak within a tenth of a dB)', () => {
    const song = stereoSong();
    const whole = loudness([song.l, song.r], SR);
    const ls = new LoudnessStream(SR, true);
    let at = 0;
    feed(song.l, (p) => {
      ls.push(p, song.r.subarray(at, at + p.length));
      at += p.length;
    });
    const got = ls.finish();
    expect(got.lufs).toBeCloseTo(whole.lufs, 6);
    expect(Math.abs(got.truePeakDb - whole.truePeakDb)).toBeLessThan(0.1);
    // Mono.
    const m1 = loudness([song.l], SR);
    const l1 = new LoudnessStream(SR, false);
    l1.push(song.l, null);
    expect(l1.finish().lufs).toBeCloseTo(m1.lufs, 6);
  });

  it('finds an inter-sample peak that no sample shows, in a quiet-then-loud song', () => {
    const n = SR * 8;
    const x = new Float32Array(n);
    // Quiet for 5 s, then a loud tone whose crests fall between samples.
    for (let i = 0; i < n; i++) x[i] = (i < SR * 5 ? 0.05 : 0.7) * Math.sin((2 * Math.PI * 11025.5 * i) / SR + 0.7);
    const whole = loudness([x, x], SR);
    const ls = new LoudnessStream(SR, true);
    feed(x, (p) => ls.push(p, p));
    expect(Math.abs(ls.finish().truePeakDb - whole.truePeakDb)).toBeLessThan(0.1);
  });
});

/** What must agree between the two ways of analyzing. */
function expectSameAnalysis(a: TrackAnalysis, b: TrackAnalysis, exact: boolean): void {
  expect(a.durationSec).toBeCloseTo(b.durationSec, 3);
  expect(a.grid).not.toBeNull();
  expect(b.grid).not.toBeNull();
  expect(Math.abs(a.grid!.bpm - b.grid!.bpm)).toBeLessThanOrEqual(0.05);
  expect(a.grid!.beatsPerBar).toBe(b.grid!.beatsPerBar);
  expect(Math.abs(a.grid!.firstDownbeat - b.grid!.firstDownbeat)).toBeLessThan(0.01);
  expect(a.key?.camelot).toBe(b.key?.camelot);
  expect(Math.abs(a.lufs - b.lufs)).toBeLessThan(0.05);
  expect(Math.abs(a.truePeakDb - b.truePeakDb)).toBeLessThan(0.1);
  expect(a.energy.length).toBe(b.energy.length);
  for (let i = 0; i < a.energy.length; i++) expect(Math.abs(a.energy[i]! - b.energy[i]!)).toBeLessThan(exact ? 1e-9 : 0.08);
  expect(a.sections.map((s) => s.kind)).toEqual(b.sections.map((s) => s.kind));
  expect(Math.abs(a.mixIn - b.mixIn)).toBeLessThan(exact ? 1e-9 : 4);
  expect(Math.abs(a.mixOut - b.mixOut)).toBeLessThan(exact ? 1e-9 : 4);
}

describe('streaming analysis equals the whole-file analysis', () => {
  const cases: [string, Partial<TestSongSpec>][] = [
    ['house, 122 BPM', {}],
    ['trap half-time, 141.5 BPM', { bpm: 141.5, pattern: PATTERNS.trap, offset: 0.81 }],
    ['boom bap with swing, 90 BPM', { bpm: 90, pattern: { ...PATTERNS.boomBap, swing: 0.62 }, offset: 1.9 }],
  ];
  for (const [name, spec] of cases)
    it(`${name}: the same grid, key, loudness, energy and sections`, async () => {
      const song = stereoSong(spec, 0.5);
      const whole = runAnalysis({ hash: 'h', channels: [song.l, song.r], sampleRate: SR });
      const got = await streamed(arraySource(song.l, song.r), { chunkFrames: 70001 });
      expectSameAnalysis(got, whole, true);
      expect(got.grid!.bpm).toBe(song.bpm);
      // Everything the features give is identical when the level scan covers the whole song.
      expect(got.grid).toEqual(whole.grid);
      expect(got.sections).toEqual(whole.sections);
      expect(got.key).toEqual(whole.key);
    }, 120_000);

  it('a level estimated from a few regions of the song gives the same tempo, key and downbeat', async () => {
    const song = stereoSong({}, 0.5);
    const whole = runAnalysis({ hash: 'h', channels: [song.l, song.r], sampleRate: SR });
    // 12 s of the 50 s song, in two regions.
    const got = await streamed(arraySource(song.l, song.r), { chunkFrames: 65536, scanBudgetSec: 12, scanRegionSec: 6 });
    expectSameAnalysis(got, whole, false);
  }, 120_000);

  it('a mono file and a file at 48 kHz give the same musical facts', async () => {
    const song = stereoSong({}, 0.5);
    const whole = runAnalysis({ hash: 'h', channels: [song.l], sampleRate: SR });
    const mono = await streamed(arraySource(song.l, null));
    expectSameAnalysis(mono, whole, false);
    // The song resampled to 48 kHz by linear interpolation (a different analysis rate: 24 kHz).
    const n48 = Math.floor((song.l.length * 48000) / SR);
    const l48 = new Float32Array(n48);
    const r48 = new Float32Array(n48);
    for (let i = 0; i < n48; i++) {
      const t = (i * SR) / 48000;
      const a = Math.floor(t);
      const f = t - a;
      l48[i] = song.l[a]! * (1 - f) + (song.l[a + 1] ?? 0) * f;
      r48[i] = song.r[a]! * (1 - f) + (song.r[a + 1] ?? 0) * f;
    }
    const got = await streamed(arraySource(l48, r48, 48000));
    expect(Math.abs(got.grid!.bpm - whole.grid!.bpm)).toBeLessThanOrEqual(0.05);
    expect(got.key?.camelot).toBe(whole.key?.camelot);
    expect(Math.abs(got.grid!.firstDownbeat - whole.grid!.firstDownbeat)).toBeLessThan(0.02);
  }, 120_000);

  it('reads a WAV file by ranges (16-bit, odd chunk sizes) and gets what the decoded file gives', async () => {
    const song = stereoSong({}, 0.5);
    const bytes = encodeWav([song.l, song.r], SR, { bitDepth: 16 });
    const pcm = decodePcm(bytes)!;
    const whole = runAnalysis({ hash: 'h', channels: [pcm.channels[0]!, pcm.channels[1]!], sampleRate: SR });
    const src = (await openSegmentSource({ reader: byteReaderOf(bytes), sampleRate: SR }))!;
    expect(src.nativeFrames).toBe(song.l.length);
    const got = await streamed(src, { chunkFrames: 100003 });
    expectSameAnalysis(got, whole, true);
    src.dispose();
  }, 120_000);

  it('reports progress from 0 to 1 and never backwards', async () => {
    const song = stereoSong({}, 0.5);
    const seen: number[] = [];
    await streamed(arraySource(song.l, song.r), { chunkFrames: 100000, onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(10);
    expect(seen[0]!).toBeLessThan(0.05);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((f, i) => i === 0 || f >= seen[i - 1]!)).toBe(true);
  }, 120_000);

  it('stops when cancelled, between chunks', async () => {
    const song = stereoSong({}, 0.5);
    const c = new AbortController();
    let reads = 0;
    const src = arraySource(song.l, song.r);
    const counting: StreamSource = {
      ...src,
      readNative: (s, n, l, r) => {
        if (++reads === 6) c.abort();
        return src.readNative(s, n, l, r);
      },
    };
    await expect(streamed(counting, { chunkFrames: 100000, signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    // Two chunks of the scan (the song is 50 s: 22 chunks of 100000 frames in all) and not the whole song.
    expect(reads).toBeLessThan(10);
  }, 120_000);
});
