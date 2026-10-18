/**
 * The MP4 muxer, checked by reading its output back with an independent reader: the box tree
 * (ftyp, moov, mdat in faststart order), the sample tables of each track, every sample's bytes through
 * them, the edit list that cuts AAC's priming, and the space reserved for the index.
 */
import { describe, expect, it } from 'vitest';
import { AAC_FRAME, AAC_PRIMING, Mp4Error, Mp4Muxer, reservedMoovSize, type Mp4Options } from '@core/io/mp4';
import type { MuxChunk, MuxWriter } from '@core/io/webm';
import { frameDurationUs, frameTimeUs } from '@core/video/timing';
import { boxes, parseMp4, readSamples } from '../helpers/mp4-parse';

function memoryWriter() {
  let buf = new Uint8Array(1 << 16);
  let size = 0;
  const w: MuxWriter = {
    write(bytes) {
      if (size + bytes.length > buf.length) {
        const grown = new Uint8Array(Math.max(buf.length * 2, size + bytes.length));
        grown.set(buf.subarray(0, size));
        buf = grown;
      }
      buf.set(bytes, size);
      size += bytes.length;
    },
    patch(at, bytes) {
      if (at + bytes.length > size) throw new Error('patch past the end');
      buf.set(bytes, at);
    },
  };
  return { w, bytes: () => buf.slice(0, size) };
}

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

const AVCC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
const ASC = Uint8Array.from([0x11, 0x90]);

function videoChunks(seconds: number, fps: number, keyEvery: number, seed = 1): MuxChunk[] {
  const r = rng(seed);
  const n = Math.round(seconds * fps);
  return Array.from({ length: n }, (_, i) => ({
    timestampUs: frameTimeUs(i, fps),
    durationUs: frameDurationUs(i, fps),
    key: i % keyEvery === 0,
    data: Uint8Array.from({ length: 40 + Math.floor(r() * 300) }, () => Math.floor(r() * 256)),
  }));
}

function audioChunks(seconds: number, seed = 2): MuxChunk[] {
  const r = rng(seed);
  const n = Math.ceil((seconds * 48000) / AAC_FRAME);
  return Array.from({ length: n }, (_, i) => ({
    timestampUs: Math.round((i * AAC_FRAME * 1e6) / 48000),
    durationUs: Math.round((AAC_FRAME * 1e6) / 48000),
    key: true,
    data: Uint8Array.from({ length: 30 + Math.floor(r() * 200) }, () => Math.floor(r() * 256)),
  }));
}

const opts = (over: Partial<Mp4Options> = {}): Mp4Options => ({
  video: { width: 1920, height: 1080, fps: 30, avcC: AVCC },
  audio: { channels: 2, sampleRate: 48000, audioSpecificConfig: ASC, priming: AAC_PRIMING },
  maxSeconds: 60,
  keyFrameSeconds: 2,
  ...over,
});

function mux(video: MuxChunk[], audio: MuxChunk[], o: Mp4Options = opts()) {
  const mem = memoryWriter();
  const m = new Mp4Muxer(mem.w, audio.length ? o : { ...o, audio: undefined });
  let ai = 0;
  for (const v of video) {
    m.addVideo(v);
    while (ai < audio.length && audio[ai]!.timestampUs <= v.timestampUs + 40000) m.addAudio(audio[ai++]!);
  }
  while (ai < audio.length) m.addAudio(audio[ai++]!);
  m.finish();
  return { m, bytes: mem.bytes() };
}

describe('Mp4Muxer', () => {
  const video = videoChunks(7, 30, 60);
  const audio = audioChunks(7);

  it('writes ftyp, then moov, then mdat (faststart) that fill the file exactly', () => {
    const { bytes, m } = mux(video, audio);
    const top = boxes(bytes);
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
    expect(m.size).toBe(bytes.length);
    const f = parseMp4(bytes);
    expect(f.brands[0]).toBe('isom');
    expect(f.brands).toContain('avc1');
    // The reservation is exactly full: moov + free is the space reserved, and mdat starts right after.
    expect(top[3]!.at).toBe(top[1]!.at + reservedMoovSize(opts()));
    expect(top[3]!.at + top[3]!.size).toBe(bytes.length);
  });

  it('describes both tracks', () => {
    const f = parseMp4(mux(video, audio).bytes);
    expect(f.tracks).toHaveLength(2);
    const [v, a] = f.tracks;
    expect(v).toMatchObject({ id: 1, handler: 'vide', timescale: 90000, entry: 'avc1', width: 1920, height: 1080 });
    expect([...v!.codecBox]).toEqual([...AVCC]);
    expect(a).toMatchObject({ id: 2, handler: 'soun', timescale: 48000, entry: 'mp4a' });
    expect(f.movie.timescale).toBe(1000);
    expect(f.movie.nextTrack).toBe(3);
    // The esds holds the AudioSpecificConfig.
    const esds = a!.codecBox;
    expect(esds.length).toBeGreaterThan(20);
    const hay = [...esds].join(',');
    expect(hay.includes([...ASC].join(','))).toBe(true);
  });

  it('indexes every sample so reading back through the tables gives the original bytes', () => {
    const bytes = mux(video, audio).bytes;
    const f = parseMp4(bytes);
    const [v, a] = f.tracks as [ReturnType<typeof parseMp4>['tracks'][0], ReturnType<typeof parseMp4>['tracks'][0]];
    expect(v.sizes).toHaveLength(video.length);
    expect(a.sizes).toHaveLength(audio.length);
    const vs = readSamples(bytes, v);
    const as = readSamples(bytes, a);
    expect(vs).toHaveLength(video.length);
    expect(as).toHaveLength(audio.length);
    vs.forEach((s, i) => expect([...s]).toEqual([...video[i]!.data]));
    as.forEach((s, i) => expect([...s]).toEqual([...audio[i]!.data]));
    // All sample data lies inside mdat.
    for (const t of [v, a]) for (const o of t.chunkOffsets) expect(o).toBeGreaterThanOrEqual(f.mdat.start);
  });

  it('writes the key frames, the time of every sample and the durations', () => {
    const f = parseMp4(mux(video, audio).bytes);
    const [v, a] = f.tracks as [ReturnType<typeof parseMp4>['tracks'][0], ReturnType<typeof parseMp4>['tracks'][0]];
    // Key frames at frames 0, 60, 120, 180 (1-based sample numbers).
    expect(v.stss).toEqual([1, 61, 121, 181]);
    // 30 fps at 90 kHz: every frame is 3000 ticks.
    expect(v.stts).toEqual([[210, 3000]]);
    expect(v.mediaDuration).toBe(210 * 3000);
    expect(v.duration).toBe(7000);
    // AAC: every packet is 1024 samples.
    expect(a.stts).toEqual([[audio.length, AAC_FRAME]]);
    expect(a.stss).toBeNull();
    expect(a.mediaDuration).toBe(audio.length * AAC_FRAME);
    // The edit list cuts the priming and keeps the music's length.
    expect(a.elst).toHaveLength(1);
    expect(a.elst[0]!.mediaTime).toBe(AAC_PRIMING);
    expect(a.elst[0]!.duration).toBe(Math.round(((audio.length * AAC_FRAME - AAC_PRIMING) * 1000) / 48000));
    expect(f.movie.duration).toBe(Math.max(v.duration, a.duration));
  });

  it('groups samples into chunks of about half a second, with the right stsc runs', () => {
    const f = parseMp4(mux(video, audio).bytes);
    const [v, a] = f.tracks as [ReturnType<typeof parseMp4>['tracks'][0], ReturnType<typeof parseMp4>['tracks'][0]];
    // 7 s in 0.5 s groups: 14 chunks of 15 video frames (the stsc says so in one run).
    expect(v.chunkOffsets.length).toBeGreaterThanOrEqual(13);
    expect(v.chunkOffsets.length).toBeLessThanOrEqual(15);
    expect(v.stsc[0]).toEqual([1, 15, 1]);
    expect(v.sizes.length).toBe(video.length);
    // Chunk offsets rise and video and audio chunks alternate in the file (interleaved).
    const all = [...v.chunkOffsets.map((o) => ['v', o] as const), ...a.chunkOffsets.map((o) => ['a', o] as const)].sort((x, y) => x[1] - y[1]);
    let switches = 0;
    for (let i = 1; i < all.length; i++) if (all[i]![0] !== all[i - 1]![0]) switches++;
    expect(switches).toBeGreaterThanOrEqual(all.length - 2);
    for (let i = 1; i < v.chunkOffsets.length; i++) expect(v.chunkOffsets[i]!).toBeGreaterThan(v.chunkOffsets[i - 1]!);
  });

  it('makes a video-only file', () => {
    const f = parseMp4(mux(video, []).bytes);
    expect(f.tracks).toHaveLength(1);
    expect(f.movie.nextTrack).toBe(2);
  });

  it('reserves enough space for an hour at 60 fps and leaves a valid free box for what it does not use', () => {
    const big = opts({ video: { width: 1080, height: 1920, fps: 60, avcC: AVCC }, maxSeconds: 3600 });
    const reserved = reservedMoovSize(big);
    // An hour's index: about 216 000 video samples at 4 bytes plus 4 bytes of chunk numbers... under 2 MB.
    expect(reserved).toBeGreaterThan(900_000);
    expect(reserved).toBeLessThan(2_500_000);
    // A short file in the same reservation: the rest is a free box.
    const v = videoChunks(3, 60, 120);
    const mem = memoryWriter();
    const m = new Mp4Muxer(mem.w, big);
    v.forEach((c) => m.addVideo(c));
    m.finish();
    const top = boxes(mem.bytes());
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
    expect(top[1]!.size + top[2]!.size).toBe(reserved);
  });

  it('refuses a file longer than the index it reserved space for', () => {
    // 2 s reserved for, 20 s given: the index outgrows its space.
    const long = videoChunks(20, 30, 60);
    const mem = memoryWriter();
    const m = new Mp4Muxer(mem.w, opts({ maxSeconds: 2, audio: undefined }));
    long.forEach((c) => m.addVideo(c));
    expect(() => m.finish()).toThrow(Mp4Error);
  });

  it('refuses frames that arrive out of order (B-frames)', () => {
    const mem = memoryWriter();
    const m = new Mp4Muxer(mem.w, opts({ audio: undefined }));
    m.addVideo({ timestampUs: 0, durationUs: 33333, key: true, data: new Uint8Array([1]) });
    m.addVideo({ timestampUs: 66667, durationUs: 33333, key: false, data: new Uint8Array([2]) });
    expect(() => m.addVideo({ timestampUs: 33333, durationUs: 33333, key: false, data: new Uint8Array([3]) })).toThrow(Mp4Error);
  });

  it('writes an index smaller than the space it reserved', () => {
    const o = opts();
    const { bytes } = mux(video, audio, o);
    const top = boxes(bytes);
    expect(top[1]!.size).toBeLessThan(reservedMoovSize(o));
  });

  it('keeps 60 fps timing exact', () => {
    const v = videoChunks(4, 60, 120);
    const f = parseMp4(mux(v, [], opts({ video: { width: 640, height: 360, fps: 60, avcC: AVCC } })).bytes);
    expect(f.tracks[0]!.stts).toEqual([[240, 1500]]);
    expect(f.tracks[0]!.stss).toEqual([1, 121]);
  });
});
