/**
 * What the long-song analysis tests share (`test/browser/dj-long-analysis*.test.ts`): a two-minute test song, a WAV and an MP3
 * of any length made from it on demand, and the checks on what the analysis gives. They are three files, not one, so the
 * three long analyses (30 minutes, 2 hours, 13 minutes of MP3) run side by side in separate pages instead of one after the other.
 */
import { Mp3StreamEncoder } from '@app/export/mp3';
import { createTrackAnalyzer, memoryAnalysisStorage } from '@app/dj/analysis-cache';
import { openLongSource } from '@app/dj/analysis-stream-run';
import type { Services } from '@app/services';
import { newId } from '@core/model/ids';
import { PATTERNS, chord, MAJOR, MINOR, renderTestSong } from '@core/dj/test-songs';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import { expect } from 'vitest';


export const RATE = 44100;
export const BPM = 128;
export const BAR = (4 * 60) / BPM;
export const MB = 1024 * 1024;

/** Two minutes at 128 BPM in A minor (64 bars: it loops without a seam), stereo, quantized to 16 bits as a file would be. */
export const base = (() => {
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
export function virtualWav(seconds: number): Blob {
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
export function mp3Of(seconds: number, kbps = 128): Blob {
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

export const refOf = (hash: string, seconds: number, ext: 'wav' | 'mp3'): SampleRef => ({
  id: newId.sample(),
  name: `${seconds} s`,
  source: { kind: 'embedded', hash, ext },
  durationSec: seconds,
  sampleRate: RATE,
  channels: 2,
});

/** The tab's memory with its Workers (what the browser says it is holding), or null where the browser can't say. */
export async function agentMemory(): Promise<number | null> {
  const p = performance as Performance & { measureUserAgentSpecificMemory?(): Promise<{ bytes: number }> };
  if (!p.measureUserAgentSpecificMemory || !crossOriginIsolated) return null;
  try {
    return (await p.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

/** Runs `work` while sampling the memory the browser reports; the biggest sample is the peak (bytes), null without the API. */
export async function withPeakMemory<T>(work: () => Promise<T>): Promise<{ result: T; before: number | null; peak: number | null; seconds: number }> {
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

export const mb = (x: number | null) => (x === null ? 'n/a' : `${(x / MB).toFixed(0)} MB`);

/** How far a time is from the nearest bar line of the song (the loop starts on one). */
export const offBar = (t: number) => {
  const k = Math.round(t / BAR);
  return Math.abs(t - k * BAR);
};

export function analyzer(blob: Blob) {
  return createTrackAnalyzer({
    storage: memoryAnalysisStorage(),
    openStream: (_s, ref) => openLongSource(ref, { getBlob: async () => blob }),
  });
}
export const noServices = {} as Services;

/** What must agree between the two ways of analyzing the same audio. */
export function expectSame(a: TrackAnalysis, b: TrackAnalysis): void {
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
