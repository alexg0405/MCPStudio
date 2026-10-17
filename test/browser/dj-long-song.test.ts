/**
 * DJ decks with songs too long to hold whole (headless Chrome, 48 kHz): a deck keeps a window of its song in a pool of shared
 * memory and fills it from the file by ranges (`engine/deck/deck-stream.ts`, `deck-source.ts`). Checks that reading a song in
 * parts is exactly decoding it whole (MP3 across the seams between decoded pieces, resampled across the seams between
 * blocks), that a 2-hour song (made up as it is read: 1.3 GB of WAV that never exists) loads and plays from anywhere in about
 * 100 MB, and what a jump far outside the window sounds like.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Mp3StreamEncoder } from '@app/export/mp3';
import { fakeAnalyzer, setTrackAnalyzer } from '@app/dj/analyzer';
import { createDecks, type DecksDeps } from '@app/dj/decks';
import { addSongFiles, library } from '@app/dj/library';
import { createServices, type Services } from '@app/services';
import { decodePcm } from '@core/io/wav';
import { Resampler } from '@core/audio/resample';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import { blobReader, openSegmentSource } from '@engine/deck/deck-source';
import { SampleCache } from '@engine/samples';
import { newId } from '@core/model/ids';
import { onsetFrames } from '../helpers/audio';

const SR = 48000;
const FILE_RATE = 44100;

// ---------------------------------------------------------------------------------------------
// MP3 by pieces

function chirp(seconds: number): Float32Array[] {
  const n = Math.round(seconds * FILE_RATE);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let s = 7;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const nz = (s / 0xffffffff - 0.5) * 0.2;
    const t = i / FILE_RATE;
    l[i] = 0.3 * Math.sin(2 * Math.PI * (300 + 40 * t) * t) + nz;
    r[i] = 0.3 * Math.sin(2 * Math.PI * (500 + 25 * t) * t) + nz * 0.7;
  }
  return [l, r];
}

function mp3Of(sig: Float32Array[], kbps = 128): Uint8Array {
  const enc = new Mp3StreamEncoder(2, FILE_RATE, kbps);
  const parts: Uint8Array[] = [enc.header()];
  for (let i = 0; i < sig[0]!.length; i += FILE_RATE) parts.push(enc.push([sig[0]!.subarray(i, i + FILE_RATE), sig[1]!.subarray(i, i + FILE_RATE)]));
  parts.push(enc.finish());
  const fin = enc.finalHeader();
  if (fin) parts[0] = fin;
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('a song read by parts is the song decoded whole', () => {
  it('MP3: every stretch, across the seams between decoded pieces, is what decodeAudioData gives for the whole file', async () => {
    const bytes = mp3Of(chirp(40));
    const whole = await new OfflineAudioContext(2, 1, FILE_RATE).decodeAudioData(bytes.slice().buffer);
    const source = (await openSegmentSource({ reader: blobReader(new Blob([bytes as BlobPart])), sampleRate: FILE_RATE }))!;
    expect(source).not.toBeNull();
    expect(source.frames).toBe(whole.length);
    expect(source.channels).toBe(2);
    // A piece is 256 frames of 1152 samples (294912 samples, minus the gapless skip of 1105): read across several seams.
    const piece = 256 * 1152;
    const spans: [number, number][] = [
      [0, 3000],
      [piece - 1105 - 700, 1500],
      [2 * piece - 1105 - 20000, 70000],
      [whole.length - 5000, 5000],
      [12345, 65536],
    ];
    let worst = 0;
    for (const [start, n] of spans) {
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      await source.read(start, n, l, r);
      const wl = whole.getChannelData(0);
      const wr = whole.getChannelData(1);
      for (let i = 0; i < n; i++) {
        worst = Math.max(worst, Math.abs(l[i]! - wl[start + i]!), Math.abs(r[i]! - wr[start + i]!));
      }
    }
    console.log(`MP3 by pieces vs decoded whole: worst difference ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-6);
    source.dispose();
  }, 120_000);

  it('MP3 at another rate: the blocks join as the whole file converted in one go (no seam)', async () => {
    const bytes = mp3Of(chirp(30));
    const whole = await new OfflineAudioContext(2, 1, FILE_RATE).decodeAudioData(bytes.slice().buffer);
    const source = (await openSegmentSource({ reader: blobReader(new Blob([bytes as BlobPart])), sampleRate: SR }))!;
    const rs = new Resampler(FILE_RATE, SR);
    const total = Math.round((whole.length * SR) / FILE_RATE);
    expect(source.frames).toBe(total);
    // Blocks of 65536 frames, as the stream reads them, over the first two pieces.
    const l = new Float32Array(65536);
    const r = new Float32Array(65536);
    let worst = 0;
    for (let b = 0; b < 8; b++) {
      await source.read(b * 65536, 65536, l, r);
      const need = rs.need(b * 65536, 65536);
      const ref = new Float32Array(65536);
      rs.convert(whole.getChannelData(0).subarray(Math.max(0, need.from), need.to), Math.max(0, need.from), ref, b * 65536, 65536);
      for (let i = 0; i < 65536; i++) worst = Math.max(worst, Math.abs(l[i]! - ref[i]!));
    }
    expect(worst).toBeLessThan(1e-6);
    source.dispose();
  }, 120_000);

  it('costs little to keep a window filled: a block of 1.4 s takes milliseconds (MP3 decode and resample; WAV and resample)', async () => {
    const mp3 = await openSegmentSource({ reader: blobReader(new Blob([mp3Of(chirp(60)) as BlobPart])), sampleRate: SR });
    const wav = await openSegmentSource({ reader: blobReader(virtualWav(60)), sampleRate: SR });
    const l = new Float32Array(65536);
    const r = new Float32Array(65536);
    for (const [name, src] of [
      ['MP3', mp3!],
      ['WAV', wav!],
    ] as const) {
      await src.read(0, 65536, l, r);
      const t0 = performance.now();
      const blocks = 30;
      for (let b = 1; b <= blocks; b++) await src.read(b * 65536, 65536, l, r);
      const ms = (performance.now() - t0) / blocks;
      // A block is 1.365 s of audio: this much of one core keeps a deck's window filled while it plays (and it is only spent while the window is filling).
      console.log(`${name}: ${ms.toFixed(1)} ms per block of 65536 frames (${((ms / 1365) * 100).toFixed(2)} % of a core at real-time speed)`);
      expect(ms).toBeLessThan(120);
      src.dispose();
    }
  }, 120_000);

  it('refuses what it cannot read by parts (the caller decodes those whole)', async () => {
    const odd = new Uint8Array(4096);
    odd.set(new TextEncoder().encode('OggS'));
    expect(await openSegmentSource({ reader: blobReader(new Blob([odd as BlobPart])), sampleRate: SR })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// A 2-hour song that is made up as it is read

const BEAT = 0.5;
const FILE_SECONDS = 2 * 3600;

/** A song at 120 BPM: a quiet tone with a 1 kHz click on every beat. Frame i of the file, in the file's rate (44.1 kHz). */
function songSample(i: number): number {
  const t = i / FILE_RATE;
  const k = t - Math.floor(t / BEAT) * BEAT;
  const click = k < 0.02 ? 0.7 * Math.exp(-k * 700) * Math.sin(2 * Math.PI * 1000 * k) : 0;
  return 0.08 * Math.sin(2 * Math.PI * 220 * t) + click;
}

/** A WAV file of `seconds` of `songSample` (16-bit stereo, right at half level) that has no bytes: any range is made on demand. */
function virtualWav(seconds: number): Blob {
  const frames = Math.round(seconds * FILE_RATE);
  const dataBytes = frames * 4;
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  header.set(new TextEncoder().encode('RIFF'));
  v.setUint32(4, 36 + dataBytes, true);
  header.set(new TextEncoder().encode('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, FILE_RATE, true);
  v.setUint32(28, FILE_RATE * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  header.set(new TextEncoder().encode('data'), 36);
  v.setUint32(40, dataBytes, true);
  const range = (a: number, b: number): Uint8Array => {
    const lo = Math.max(0, a);
    const hi = Math.min(44 + dataBytes, b);
    const out = new Uint8Array(Math.max(0, hi - lo));
    let o = 0;
    let p = lo;
    // The header, then whole frames (a range may start inside one).
    while (p < Math.min(hi, 44)) out[o++] = header[p++] as number;
    if (p < hi) {
      let f = Math.floor((p - 44) / 4);
      let within = (p - 44) % 4;
      while (p < hi) {
        const x = songSample(f);
        const l = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
        const r = Math.max(-32768, Math.min(32767, Math.round(x * 0.5 * 32767)));
        const frameBytes = [l & 0xff, (l >> 8) & 0xff, r & 0xff, (r >> 8) & 0xff];
        for (let k = within; k < 4 && p < hi; k++) {
          out[o++] = frameBytes[k] as number;
          p++;
        }
        within = 0;
        f++;
      }
    }
    return out;
  };
  return {
    size: 44 + dataBytes,
    slice: (a = 0, b = 44 + dataBytes) => ({ arrayBuffer: async () => range(a, b).buffer }),
  } as unknown as Blob;
}

function longRig(seconds: number) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const host: DeckHost = { ctx, output: ctx.destination, loadModule: (u) => ctx.audioWorklet.addModule(u), heardTime: () => ctx.currentTime };
  const toasts: string[] = [];
  const file = virtualWav(FILE_SECONDS);
  const ref: SampleRef = {
    id: newId.sample(),
    name: 'Two hours',
    source: { kind: 'embedded', hash: 'b'.repeat(64), ext: 'wav' },
    durationSec: FILE_SECONDS,
    sampleRate: FILE_RATE,
    channels: 2,
  };
  const deps: DecksDeps = {
    host: () => host,
    subscribeHost: () => () => {},
    resume: async () => {},
    cache: new SampleCache({ getBytes: async () => null }),
    openFile: async () => file,
    peekAnalysis: () => null,
    analysis: async () => null,
    addRecording: async () => null,
    toast: (m) => void toasts.push(m),
  };
  const decks = createDecks(deps);
  return { ctx, decks, toasts, ref };
}

async function memory(): Promise<number | null> {
  const p = performance as Performance & { measureUserAgentSpecificMemory?(): Promise<{ bytes: number }> };
  if (!p.measureUserAgentSpecificMemory || !crossOriginIsolated) return null;
  try {
    return (await p.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleep = wait;
const MB = 1024 * 1024;

describe('decks: a 2-hour song', () => {
  it('loads, plays from anywhere (cue points, far jumps) and stays under 200 MB', async () => {
    const before = await memory();
    const rig = longRig(4);
    await rig.decks.load('A', rig.ref, 'Two hours');
    rig.decks.setCrossfader(-1);
    expect(rig.toasts).toEqual([]);
    const deck = () => rig.decks.store.getState().decks.A;
    expect(deck().song?.durationSec).toBeCloseTo(FILE_SECONDS, 3);
    // A hot cue far into the song, set where the deck is: kept loaded while the playhead goes elsewhere.
    rig.decks.seek('A', 5000.25);
    rig.decks.hotCue('A', 0);
    expect(deck().hotCues[0]).not.toBeNull();
    // Go to the very end of the 2 hours and play from 1:30:00.
    rig.decks.seek('A', 5400.1);
    await rig.decks.settled?.();
    rig.decks.play('A');
    const out = await (async () => {
      await rig.decks.settled?.();
      const buf = await rig.ctx.startRendering();
      return buf.getChannelData(0);
    })();
    // 5400.1 → clicks at 5400.5, 5401.0 …: heard 0.4 s, 0.9 s, 1.4 s … after the start. The master limiter looks 64 frames
    // ahead (1.3 ms of delay for everything that plays), so they are that much later; their spacing is exact.
    const clicks = onsetFrames(out, SR, 0.3, 0.2);
    expect(clicks.length).toBeGreaterThanOrEqual(6);
    for (let k = 0; k < 6; k++) expect(Math.abs((clicks[k]! - (0.4 + 0.5 * k) * SR) / SR) * 1000).toBeLessThan(2);
    for (let k = 1; k < 6; k++) expect(Math.abs(clicks[k]! - clicks[k - 1]! - 0.5 * SR)).toBeLessThanOrEqual(1);
    const level = Math.max(...Array.from(out.subarray(clicks[0]!, clicks[0]! + 300), Math.abs));
    // The click's own peak (0.7 × e^-0.17 at the first quarter cycle of 1 kHz): not silence, not garbled.
    expect(level).toBeGreaterThan(0.5);
    expect(level).toBeLessThan(0.7);
    // Let the window fill, then count what the deck holds: the pool, whatever the song's length.
    await wait(1500);
    const after = await memory();
    if (before !== null && after !== null) {
      const used = (after - before) / MB;
      console.log(`a 2-hour song on a deck (window, overview, tables): ${used.toFixed(0)} MB of page memory`);
      expect(used).toBeLessThan(200);
    }
    rig.decks.dispose();
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// The real app path: a 12½-minute file in the sample store (OPFS), the real engine, real time

/** A 16-bit stereo WAV of `seconds`: a quiet tone whose pitch is 200 Hz + 25 Hz per minute (so where the deck is can be heard) and a click every beat. */
function markedWav(seconds: number): Uint8Array {
  const frames = Math.round(seconds * FILE_RATE);
  const bytes = new Uint8Array(44 + frames * 4);
  const v = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'));
  v.setUint32(4, 36 + frames * 4, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, FILE_RATE, true);
  v.setUint32(28, FILE_RATE * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  v.setUint32(40, frames * 4, true);
  const pcm = new Int16Array(bytes.buffer, 44, frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / FILE_RATE;
    const minute = Math.floor(t / 60);
    const tt = t - minute * 60;
    const k = t - Math.floor(t / BEAT) * BEAT;
    const click = k < 0.02 ? 0.5 * Math.exp(-k * 700) * Math.sin(2 * Math.PI * 1000 * k) : 0;
    const x = 0.1 * Math.sin(2 * Math.PI * (200 + 25 * minute) * tt) + click;
    pcm[2 * i] = Math.round(x * 32767);
    pcm[2 * i + 1] = Math.round(x * 0.5 * 32767);
  }
  return bytes;
}

/** Runs of near-silence (≤ 3 LSB) longer than `minSamples` in a channel: [start, length] in samples. */
function silences(x: Float32Array, minSamples: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= x.length; i++) {
    const quiet = i < x.length && Math.abs(x[i]!) <= 3 / 32768;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if (i - start >= minSamples) out.push([start, i - start]);
      start = -1;
    }
  }
  return out;
}

/** Zero crossings per second of x[from…to): the tone's pitch × 2 (the clicks add a few). */
function crossingsPerSecond(x: Float32Array, rate: number, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
  return (n * rate) / (to - from);
}

describe('decks: a long song in the real engine', () => {
  let s: Services | null = null;
  afterAll(async () => {
    (await s?.decks())?.dispose();
    await s?.engine.dispose();
    setTrackAnalyzer(null);
  });

  it('is read from the file by parts (never decoded whole), jumps to a hot cue without a gap and to an unloaded part with a short fade', async () => {
    setTrackAnalyzer(fakeAnalyzer(new Map()));
    s = createServices();
    await s.engine.resume();
    await addSongFiles(s, [new File([markedWav(12.5 * 60) as BlobPart], 'Long.wav')]);
    const song = library.getState().songs.find((x) => x.fileName === 'Long.wav')!;
    expect(song.durationSec).toBeCloseTo(750, 1);
    const decks = await s.decks();
    await decks.load('A', song.ref, song.title);
    decks.setCrossfader(-1);
    // Streamed: nothing of it was decoded whole into the shared cache.
    expect(s.sampleCache.stats().decodes).toBe(0);
    expect(s.sampleCache.usedBytes).toBeLessThan(1_000_000);
    // A hot cue at 10:00.3, then the playhead to 1:40 (an unloaded part of the song, far from the cue).
    decks.seek('A', 600.3);
    decks.hotCue('A', 0);
    decks.seek('A', 100.2);
    await sleep(600);
    const ctx = s.engine.deckHost!()!.ctx;
    await decks.startRecording();
    decks.play('A');
    await sleep(1800);
    // Jump 1: to the hot cue, which was kept loaded.
    const t1 = ctx.currentTime;
    decks.hotCue('A', 0);
    await sleep(1800);
    // Jump 2: to 6:20, which nothing has asked for yet.
    const t2 = ctx.currentTime;
    decks.seek('A', 380.1);
    await sleep(1800);
    const t3 = ctx.currentTime;
    const title = await decks.stopRecording();
    decks.pause('A');
    expect(title).not.toBeNull();
    const rec = library.getState().songs.find((x) => x.title === title)!;
    const bytes = await s.sampleCache.provider!.getBytes(rec.ref);
    const pcm = decodePcm(new Uint8Array(bytes!))!;
    const out = pcm.channels[0]!;
    const rate = pcm.sampleRate;
    // The recording starts a moment after the clock reading `t0`: find where each jump landed from the pitch of the tone.
    const total = out.length / rate;
    const t0 = t3 - total;
    const at = (t: number) => Math.round((t - t0) * rate);
    const pitch = (a: number, b: number) => crossingsPerSecond(out, rate, at(a), at(b)) / 2;
    // Before the first jump the song is at 1:40 (minute 1: 225 Hz), after it at 10:00 (minute 10: 450 Hz), then at 6:20 (minute 6: 350 Hz).
    // The clicks (1 kHz, 20 ms every half second) add a few crossings.
    expect(Math.abs(pitch(t1 - 1.3, t1 - 0.1) - 225)).toBeLessThan(60);
    expect(Math.abs(pitch(t1 + 0.4, t2 - 0.1) - 450)).toBeLessThan(60);
    expect(Math.abs(pitch(t2 + 1.0, t3 - 0.1) - 350)).toBeLessThan(60);
    // The gap at each jump: silence of the deck (the tone is never quiet for long).
    const gaps = silences(out, Math.round(0.003 * rate));
    const near = (t: number) => gaps.filter(([g]) => Math.abs(g / rate - (t - t0)) < 1.0);
    const g1 = near(t1);
    const g2 = near(t2);
    const ms = (gs: [number, number][]) => (gs.reduce((a, [, n]) => a + n, 0) / rate) * 1000;
    console.log(`jump to a hot cue: ${ms(g1).toFixed(1)} ms of silence; jump to a part that was not loaded: ${ms(g2).toFixed(1)} ms of silence`);
    expect(ms(g1)).toBeLessThan(3);
    expect(g2.length).toBeLessThanOrEqual(1);
    expect(ms(g2)).toBeLessThan(1500);
    // Nothing broke the tone, the jumps included (they fade over 2 ms): no step bigger than the tone's own (0.1 × 2π × 450 / 48000
    // = 0.006) away from the clicks (loud, 1 kHz bursts).
    const loud = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++)
      if (Math.abs(out[i]!) > 0.15) loud.fill(1, Math.max(0, i - 40), Math.min(out.length, i + 1500));
    let worst = 0;
    for (let i = 1; i < out.length; i++) {
      if (loud[i]) continue;
      worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!));
    }
    console.log(`largest step in the tone away from the clicks, jumps included: ${worst.toFixed(4)} (the tone's own 0.006)`);
    expect(worst).toBeLessThan(0.02);
  }, 120_000);
});
