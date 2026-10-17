/**
 * Track analysis of songs too long to decode whole (headless Chrome): the file is read by ranges (WAV from its bytes, MP3
 * through `decodeAudioData` a few seconds at a time on this thread), handed to the analysis Worker in chunks and analyzed
 * as it goes by (`app/dj/analysis-stream*.ts`). Checks on a 30-minute WAV (a file that has no bytes: any range is made on
 * demand) and a 13-minute MP3 made with the app's own encoder that the result is right (tempo, key, downbeat, loudness),
 * that the MP3 gives what analyzing the whole decoded file gives, how much memory the tab and its Workers use while it
 * runs and how long it takes, that cancelling stops it, and that a deck gets its grid when the analysis of its song finishes.
 *
 * `VITE_LONG_COMPARE=1` also analyzes the 30-minute WAV the old way (decoded whole) for the before/after numbers.
 */
import { describe, expect, it } from 'vitest';
import { Mp3StreamEncoder } from '@app/export/mp3';
import { createTrackAnalyzer, memoryAnalysisStorage } from '@app/dj/analysis-cache';
import { createDecks, type DecksDeps } from '@app/dj/decks';
import { loudness, runAnalysis } from '@app/dj/analysis-run';
import { openLongSource } from '@app/dj/analysis-stream-run';
import type { Services } from '@app/services';
import { newId } from '@core/model/ids';
import { PATTERNS, chord, MAJOR, MINOR, renderTestSong } from '@core/dj/test-songs';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import { SampleCache } from '@engine/samples';

const RATE = 44100;
const BPM = 128;
const BAR = (4 * 60) / BPM;
const MB = 1024 * 1024;
const compare = (import.meta.env as Record<string, string | undefined>).VITE_LONG_COMPARE === '1';

/** Two minutes at 128 BPM in A minor (64 bars: it loops without a seam), stereo, quantized to 16 bits as a file would be. */
const base = (() => {
  const song = renderTestSong({
    sampleRate: RATE,
    bpm: BPM,
    offset: 0,
    tail: 0,
    pattern: PATTERNS.house,
    chords: [chord(57, MINOR), chord(50, MINOR), chord(52, MAJOR), chord(57, MINOR)],
    parts: [
      { bars: 16, kick: true, hats: true, level: 0.7 },
      { bars: 32, kick: true, snare: true, hats: true, bass: true, pads: true },
      { bars: 16, kick: true, snare: true, hats: true, bass: true, pads: true, crash: true },
    ],
  });
  const n = song.mono.length;
  const pcm = new Int16Array(n * 2);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pcm[2 * i] = Math.round(song.mono[i]! * 32000);
    pcm[2 * i + 1] = Math.round(song.mono[i]! * 24000);
    l[i] = pcm[2 * i]! / 32768;
    r[i] = pcm[2 * i + 1]! / 32768;
  }
  return { bytes: new Uint8Array(pcm.buffer), l, r, frames: n, seconds: n / RATE };
})();

/** A WAV of `seconds` of the song looped, as a Blob that has no bytes: any range is copied from the loop on demand. */
function virtualWav(seconds: number): Blob {
  const frames = Math.round(seconds * RATE);
  const dataBytes = frames * 4;
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  header.set(new TextEncoder().encode('RIFF'));
  v.setUint32(4, 36 + dataBytes, true);
  header.set(new TextEncoder().encode('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  header.set(new TextEncoder().encode('data'), 36);
  v.setUint32(40, dataBytes, true);
  const size = 44 + dataBytes;
  const range = (a: number, b: number): Uint8Array => {
    const end = Math.min(size, b);
    const out = new Uint8Array(Math.max(0, end - a));
    for (let p = a, o = 0; p < end; ) {
      if (p < 44) {
        out[o++] = header[p++]!;
        continue;
      }
      const within = (p - 44) % base.bytes.length;
      const take = Math.min(end - p, base.bytes.length - within);
      out.set(base.bytes.subarray(within, within + take), o);
      o += take;
      p += take;
    }
    return out;
  };
  return { size, slice: (a = 0, b = size) => ({ arrayBuffer: async () => range(a, b).buffer }) } as unknown as Blob;
}

/** An MP3 of `seconds` of the song looped, made by the app's encoder. */
function mp3Of(seconds: number, kbps = 128): Blob {
  const enc = new Mp3StreamEncoder(2, RATE, kbps);
  const parts: Uint8Array[] = [enc.header()];
  const total = Math.round(seconds * RATE);
  for (let at = 0; at < total; at += RATE) {
    const n = Math.min(RATE, total - at);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = base.l[(at + i) % base.frames]!;
      r[i] = base.r[(at + i) % base.frames]!;
    }
    parts.push(enc.push([l, r]));
  }
  parts.push(enc.finish());
  const fin = enc.finalHeader();
  if (fin) parts[0] = fin;
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

const refOf = (hash: string, seconds: number, ext: 'wav' | 'mp3'): SampleRef => ({
  id: newId.sample(),
  name: `${seconds} s`,
  source: { kind: 'embedded', hash, ext },
  durationSec: seconds,
  sampleRate: RATE,
  channels: 2,
});

/** The tab's memory with its Workers (what the browser says it is holding), or null where the browser can't say. */
async function agentMemory(): Promise<number | null> {
  const p = performance as Performance & { measureUserAgentSpecificMemory?(): Promise<{ bytes: number }> };
  if (!p.measureUserAgentSpecificMemory || !crossOriginIsolated) return null;
  try {
    return (await p.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

/** Runs `work` while sampling the memory the browser reports; the biggest sample is the peak (bytes), null without the API. */
async function withPeakMemory<T>(work: () => Promise<T>): Promise<{ result: T; before: number | null; peak: number | null; seconds: number }> {
  const before = await agentMemory();
  let peak = before;
  let running = true;
  const sampler = (async () => {
    while (running && before !== null) {
      const m = await agentMemory();
      if (m !== null && (peak === null || m > peak)) peak = m;
    }
  })();
  const t0 = performance.now();
  try {
    const result = await work();
    return { result, before, peak, seconds: (performance.now() - t0) / 1000 };
  } finally {
    running = false;
    await sampler;
  }
}

const mb = (x: number | null) => (x === null ? 'n/a' : `${(x / MB).toFixed(0)} MB`);

/** How far a time is from the nearest bar line of the song (the loop starts on one). */
const offBar = (t: number) => {
  const k = Math.round(t / BAR);
  return Math.abs(t - k * BAR);
};

function analyzer(blob: Blob) {
  return createTrackAnalyzer({
    storage: memoryAnalysisStorage(),
    openStream: (_s, ref) => openLongSource(ref, { getBlob: async () => blob }),
  });
}
const noServices = {} as Services;

describe('analysis of songs too long to decode whole', () => {
  it('a 30-minute WAV: right tempo, key, downbeat and loudness, in bounded memory', async () => {
    const seconds = 1800;
    const blob = virtualWav(seconds);
    const an = analyzer(blob);
    const progress: number[] = [];
    const { result: a, before, peak, seconds: took } = await withPeakMemory(() =>
      an.analyze(noServices, refOf('1'.repeat(64), seconds, 'wav'), { onProgress: (p) => progress.push(p.fraction) }),
    );
    const own = loudness([base.l, base.r], RATE);
    console.log(
      `30-minute WAV (${(blob.size / MB).toFixed(0)} MB file): ${took.toFixed(1)} s (${(seconds / took).toFixed(0)}x real time); tab and Workers ${mb(before)} before, peak ${mb(peak)} ` +
        `(+${peak !== null && before !== null ? ((peak - before) / MB).toFixed(0) : 'n/a'} MB); bpm ${a.grid?.bpm}, key ${a.key?.camelot}, first downbeat ${a.grid?.firstDownbeat}, ` +
        `${a.lufs.toFixed(2)} LUFS (the song alone ${own.lufs.toFixed(2)}), ${a.truePeakDb.toFixed(2)} dBTP, ${a.energy.length} bars, ${a.sections.length} sections`,
    );
    expect(a.durationSec).toBeCloseTo(seconds, 2);
    expect(a.grid).not.toBeNull();
    expect(Math.abs(a.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
    expect(a.grid!.beatsPerBar).toBe(4);
    expect(offBar(a.grid!.firstDownbeat)).toBeLessThan(0.01);
    expect(a.key?.camelot).toBe('8A');
    expect(Math.abs(a.lufs - own.lufs)).toBeLessThan(0.1);
    expect(Math.abs(a.truePeakDb - own.truePeakDb)).toBeLessThan(0.1);
    expect(Math.abs(a.energy.length - seconds / BAR)).toBeLessThanOrEqual(2);
    expect(a.mixOut).toBeGreaterThan(seconds - 60);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1]!)).toBe(true);
    expect(took).toBeLessThan(600);
    // The song decoded whole would be 635 MB of floats (and as much again in copies): the streaming run stays far below that.
    if (peak !== null && before !== null) expect(peak - before).toBeLessThan(250 * MB);
  }, 900_000);

  it('a 2-hour WAV (1.3 GB that never exists): the same, in under 150 MB', async () => {
    const seconds = 7200;
    const blob = virtualWav(seconds);
    const an = analyzer(blob);
    const { result: a, before, peak, seconds: took } = await withPeakMemory(() => an.analyze(noServices, refOf('6'.repeat(64), seconds, 'wav')));
    console.log(
      `2-hour WAV (${(blob.size / MB).toFixed(0)} MB file): ${took.toFixed(1)} s (${(seconds / took).toFixed(0)}x real time); tab and Workers ${mb(before)} before, peak ${mb(peak)} ` +
        `(+${peak !== null && before !== null ? ((peak - before) / MB).toFixed(0) : 'n/a'} MB); bpm ${a.grid?.bpm}, key ${a.key?.camelot}, ${a.energy.length} bars`,
    );
    expect(Math.abs(a.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
    expect(a.key?.camelot).toBe('8A');
    expect(offBar(a.grid!.firstDownbeat)).toBeLessThan(0.01);
    expect(Math.abs(a.energy.length - seconds / BAR)).toBeLessThanOrEqual(2);
    if (peak !== null && before !== null) expect(peak - before).toBeLessThan(150 * MB);
  }, 900_000);

  it('a 13-minute MP3 (the app’s encoder, decoded in pieces on this thread): what the whole decoded file gives', async () => {
    const seconds = 13 * 60;
    const t0 = performance.now();
    const blob = mp3Of(seconds);
    console.log(`13-minute MP3: ${(blob.size / MB).toFixed(1)} MB made in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const an = analyzer(blob);
    const { result: a, before, peak, seconds: took } = await withPeakMemory(() => an.analyze(noServices, refOf('2'.repeat(64), seconds, 'mp3')));
    console.log(
      `13-minute MP3: ${took.toFixed(1)} s (${(seconds / took).toFixed(0)}x real time); tab and Workers ${mb(before)} before, peak ${mb(peak)}; ` +
        `bpm ${a.grid?.bpm}, key ${a.key?.camelot}, first downbeat ${a.grid?.firstDownbeat}, ${a.lufs.toFixed(2)} LUFS`,
    );
    expect(Math.abs(a.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
    expect(a.key?.camelot).toBe('8A');
    expect(offBar(a.grid!.firstDownbeat)).toBeLessThan(0.03);
    // The whole file decoded at 44.1 kHz and analyzed the old way.
    const buffer = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(await blob.arrayBuffer());
    const whole = runAnalysis({ hash: 'w', channels: [buffer.getChannelData(0), buffer.getChannelData(1)], sampleRate: RATE });
    expectSame(a, whole);
  }, 900_000);

  it('cancelling stops the reading and the Worker, and the next analysis still works', async () => {
    const seconds = 1500;
    const blob = virtualWav(seconds);
    const an = analyzer(blob);
    const c = new AbortController();
    const t0 = performance.now();
    const doomed = an.analyze(noServices, refOf('3'.repeat(64), seconds, 'wav'), { signal: c.signal, onProgress: (p) => p.fraction > 0.1 && c.abort() });
    await expect(doomed).rejects.toMatchObject({ name: 'AbortError' });
    console.log(`cancelled after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    expect(an.peek('3'.repeat(64))).toBeNull();
    const again = await an.analyze(noServices, refOf('4'.repeat(64), 900, 'wav'));
    expect(Math.abs(again.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
  }, 600_000);

  if (compare)
    it('before: the 30-minute WAV decoded whole (the old way), for the numbers', async () => {
      const blob = virtualWav(1800);
      const t0 = performance.now();
      const start = await agentMemory();
      const bytes = new Uint8Array(await blob.slice(0, blob.size).arrayBuffer());
      const buffer = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(bytes.slice().buffer);
      const channels = [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()];
      // What the analysis holds when it starts: the file's bytes, the decoded buffer and the copies the analyzer keeps.
      const held = await agentMemory();
      const a = runAnalysis({ hash: 'old', channels, sampleRate: RATE });
      const took = (performance.now() - t0) / 1000;
      // runAnalysis then adds a mono mix (4 bytes a frame) and its 22 kHz copy (2) and the features (~20 MB per 15 minutes).
      const extra = buffer.length * 6 + 70 * MB;
      console.log(
        `BEFORE, 30-minute WAV decoded whole: ${took.toFixed(1)} s on this thread; tab ${mb(start)} before, ${mb(held)} when the analysis starts ` +
          `(bytes + decoded buffer + copies), about ${mb(held === null ? null : held + extra)} at its peak; bpm ${a.grid?.bpm}, key ${a.key?.camelot}`,
      );
    }, 900_000);
});

/** What must agree between the two ways of analyzing the same audio. */
function expectSame(a: TrackAnalysis, b: TrackAnalysis): void {
  expect(a.durationSec).toBeCloseTo(b.durationSec, 1);
  expect(b.grid).not.toBeNull();
  expect(Math.abs(a.grid!.bpm - b.grid!.bpm)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(a.grid!.firstDownbeat - b.grid!.firstDownbeat)).toBeLessThan(0.01);
  expect(a.key?.camelot).toBe(b.key?.camelot);
  expect(Math.abs(a.lufs - b.lufs)).toBeLessThan(0.1);
  expect(Math.abs(a.truePeakDb - b.truePeakDb)).toBeLessThan(0.15);
  expect(Math.abs(a.energy.length - b.energy.length)).toBeLessThanOrEqual(1);
  let worst = 0;
  for (let i = 0; i < Math.min(a.energy.length, b.energy.length); i++) worst = Math.max(worst, Math.abs(a.energy[i]! - b.energy[i]!));
  console.log(`streaming vs whole file: bpm ${a.grid!.bpm} / ${b.grid!.bpm}, downbeat ${a.grid!.firstDownbeat} / ${b.grid!.firstDownbeat}, key ${a.key?.camelot} / ${b.key?.camelot}, worst energy difference ${worst.toFixed(3)}`);
  expect(worst).toBeLessThan(0.05);
}

describe('a deck gets its grid when the analysis of its long song finishes', () => {
  it('loads at once without a grid, shows the progress, then has the tempo, the cue on the first downbeat and a sync-able grid', async () => {
    const seconds = 900;
    const blob = virtualWav(seconds);
    const ref = refOf('5'.repeat(64), seconds, 'wav');
    const an = analyzer(blob);
    const ctx = new OfflineAudioContext(2, Math.round(4 * 48000), 48000);
    const host: DeckHost = { ctx, output: ctx.destination, loadModule: (u) => ctx.audioWorklet.addModule(u), heardTime: () => ctx.currentTime };
    const toasts: string[] = [];
    const deps: DecksDeps = {
      host: () => host,
      subscribeHost: () => () => {},
      resume: async () => {},
      cache: new SampleCache({ getBytes: async () => null }),
      openFile: async () => blob,
      peekAnalysis: (r) => an.peek(r.source.kind === 'embedded' ? r.source.hash : ''),
      analysis: (r, o) => an.analyze(noServices, r, { ...(o?.signal ? { signal: o.signal } : {}), ...(o?.onProgress ? { onProgress: (p) => o.onProgress?.(p.fraction) } : {}) }),
      addRecording: async () => null,
      toast: (m) => void toasts.push(m),
    };
    const decks = createDecks(deps);
    await decks.load('A', ref, 'Fifteen minutes');
    const deck = () => decks.store.getState().decks.A;
    // Ready to play at once: no grid yet, the analysis running behind it.
    expect(deck().loading).toBe(false);
    expect(deck().baseBpm).toBeNull();
    expect(deck().analyzing).not.toBeNull();
    const seen: number[] = [];
    const unsub = decks.store.subscribe((s) => {
      const f = s.decks.A.analyzing;
      if (f !== null) seen.push(f);
    });
    const t0 = performance.now();
    while (deck().baseBpm === null && performance.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 100));
    unsub();
    console.log(`deck: grid after ${((performance.now() - t0) / 1000).toFixed(1)} s more; progress steps seen ${seen.length}`);
    expect(toasts).toEqual([]);
    expect(Math.abs(deck().baseBpm! - BPM)).toBeLessThanOrEqual(0.05);
    expect(deck().bpm).toBeCloseTo(deck().baseBpm!, 6);
    expect(deck().analyzing).toBeNull();
    expect(offBar(deck().cuePoint)).toBeLessThan(0.01);
    expect(decks.analysisOf?.('A')?.key?.camelot).toBe('8A');
    expect(decks.waveformOf?.('A')).not.toBeNull();
    // Ejecting while a long song is being analyzed stops the work.
    decks.eject('A');
    expect(deck().analyzing).toBeNull();
  }, 600_000);
});
