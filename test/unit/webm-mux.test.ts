/**
 * The WebM muxer, checked by reading its own output back with an independent parser: the EBML
 * structure, the tracks, the blocks (every byte, in time order), the clusters, the cues and the three
 * numbers it writes over the header at the end.
 */
import { describe, expect, it } from 'vitest';
import { WebmMuxer, WEBM_IDS, sizeBytes, type MuxChunk, type MuxWriter } from '@core/io/webm';
import { frameDurationUs, frameTimeUs } from '@core/video/timing';
import { parseWebm } from '../helpers/webm-parse';

/** A writer into one growing array, with the patch the muxer needs. */
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

const OPUS_HEAD = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0,
]);

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

function videoChunks(seconds: number, fps: number, keyEvery: number, seed = 1): MuxChunk[] {
  const r = rng(seed);
  const n = Math.round(seconds * fps);
  return Array.from({ length: n }, (_, i) => ({
    timestampUs: frameTimeUs(i, fps),
    durationUs: frameDurationUs(i, fps),
    key: i % keyEvery === 0,
    data: Uint8Array.from({ length: 50 + Math.floor(r() * 400) }, () => Math.floor(r() * 256)),
  }));
}

function audioChunks(seconds: number, seed = 2): MuxChunk[] {
  const r = rng(seed);
  const n = Math.round(seconds * 50);
  return Array.from({ length: n }, (_, i) => ({
    timestampUs: i * 20000,
    durationUs: 20000,
    key: true,
    data: Uint8Array.from({ length: 20 + Math.floor(r() * 100) }, () => Math.floor(r() * 256)),
  }));
}

const options = (audio = true) => ({
  video: { codec: 'V_VP9' as const, width: 1920, height: 1080, fps: 30 },
  ...(audio
    ? { audio: { codec: 'A_OPUS' as const, channels: 2, sampleRate: 48000, codecPrivate: OPUS_HEAD, preSkip: 312 } }
    : {}),
  title: 'My song',
});

function mux(
  video: MuxChunk[],
  audio: MuxChunk[],
  order: 'interleaved' | 'video first' | 'audio first' = 'interleaved',
) {
  const mem = memoryWriter();
  const m = new WebmMuxer(mem.w, options(audio.length > 0));
  if (order === 'interleaved') {
    let ai = 0;
    for (const v of video) {
      m.addVideo(v);
      while (ai < audio.length && (audio[ai] as MuxChunk).timestampUs <= v.timestampUs + 40000)
        m.addAudio(audio[ai++] as MuxChunk);
    }
    while (ai < audio.length) m.addAudio(audio[ai++] as MuxChunk);
  } else if (order === 'video first') {
    for (const v of video) m.addVideo(v);
    for (const a of audio) m.addAudio(a);
  } else {
    for (const a of audio) m.addAudio(a);
    for (const v of video) m.addVideo(v);
  }
  m.finish();
  return { m, bytes: mem.bytes() };
}

describe('sizeBytes', () => {
  it('writes EBML variable-length sizes as short as they fit, never all ones', () => {
    expect([...sizeBytes(0)]).toEqual([0x80]);
    expect([...sizeBytes(126)]).toEqual([0xfe]);
    expect([...sizeBytes(127)]).toEqual([0x40, 0x7f]);
    expect([...sizeBytes(300)]).toEqual([0x41, 0x2c]);
    expect(sizeBytes(2 ** 40).length).toBe(6);
    expect([...sizeBytes(5, 8)]).toEqual([1, 0, 0, 0, 0, 0, 0, 5]);
  });
});

describe('WebmMuxer', () => {
  const video = videoChunks(7, 30, 60);
  const audio = audioChunks(7);

  it('writes a WebM file whose structure reads back', () => {
    const { bytes, m } = mux(video, audio);
    const f = parseWebm(bytes);
    expect(f.docType).toBe('webm');
    // The Segment's size was patched from "unknown" to exactly the rest of the file.
    expect(f.segmentSize).toBe(bytes.length - f.segmentStart);
    expect(m.size).toBe(bytes.length);
    expect(f.info.timecodeScale).toBe(1_000_000);
    expect(f.info.title).toBe('My song');
    expect(f.info.muxingApp).toBe('AGstudio');
    expect(f.tracks).toHaveLength(2);
    const [v, a] = f.tracks;
    expect(v).toMatchObject({ number: 1, type: 1, codecId: 'V_VP9', width: 1920, height: 1080 });
    expect(v?.defaultDuration).toBe(Math.round(1e9 / 30));
    expect(a).toMatchObject({
      number: 2,
      type: 2,
      codecId: 'A_OPUS',
      sampleRate: 48000,
      channels: 2,
      seekPreRoll: 80_000_000,
    });
    expect(a?.codecDelay).toBe(Math.round((312 * 1e9) / 48000));
    expect([...(a?.codecPrivate ?? [])]).toEqual([...OPUS_HEAD]);
    // Top-level order: SeekHead, Info, Tracks, Clusters…, Cues.
    expect(f.top.map(([id]) => id).slice(0, 3)).toEqual([WEBM_IDS.SeekHead, WEBM_IDS.Info, WEBM_IDS.Tracks]);
    expect(f.top.at(-1)?.[0]).toBe(WEBM_IDS.Cues);
  });

  it('keeps every block byte for byte, per track in order, with monotonic timestamps', () => {
    const { bytes } = mux(video, audio);
    const f = parseWebm(bytes);
    const blocks = f.clusters.flatMap((c) => c.blocks);
    expect(blocks).toHaveLength(video.length + audio.length);
    const vb = blocks.filter((b) => b.track === 1);
    const ab = blocks.filter((b) => b.track === 2);
    expect(vb).toHaveLength(video.length);
    expect(ab).toHaveLength(audio.length);
    vb.forEach((b, i) => {
      expect([...b.data]).toEqual([...(video[i] as MuxChunk).data]);
      expect(b.key).toBe((video[i] as MuxChunk).key);
      expect(b.ms).toBe(Math.round((video[i] as MuxChunk).timestampUs / 1000));
    });
    ab.forEach((b, i) => {
      expect([...b.data]).toEqual([...(audio[i] as MuxChunk).data]);
      expect(b.key).toBe(true);
      expect(b.ms).toBe(Math.round((audio[i] as MuxChunk).timestampUs / 1000));
    });
    // Time never goes backwards in the file, across tracks and clusters.
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.ms).toBeGreaterThanOrEqual(blocks[i - 1]!.ms);
  });

  it('starts a cluster at each key frame about two seconds apart, and lists them in the cues', () => {
    const { bytes } = mux(video, audio);
    const f = parseWebm(bytes);
    // 7 s with a key frame every 2 s (frames 0, 60, 120, 180): four clusters.
    expect(f.clusters).toHaveLength(4);
    f.clusters.forEach((c, i) => {
      const firstVideo = c.blocks.find((b) => b.track === 1)!;
      expect(firstVideo.key).toBe(true);
      expect(c.timecodeMs).toBeLessThanOrEqual(firstVideo.ms);
      expect(c.timecodeMs).toBe(Math.round(frameTimeUs(i * 60, 30) / 1000));
      for (const b of c.blocks) expect(b.ms).toBeGreaterThanOrEqual(c.timecodeMs);
    });
    expect(f.cues).toHaveLength(f.clusters.length);
    f.cues.forEach((cue, i) => {
      expect(cue.track).toBe(1);
      expect(cue.clusterPosition).toBe(f.clusters[i]!.offset);
      expect(cue.timeMs).toBe(f.clusters[i]!.timecodeMs);
    });
  });

  it('points its SeekHead at the elements, the Cues included, and records the duration', () => {
    const { bytes } = mux(video, audio);
    const f = parseWebm(bytes);
    const at = (id: number) => f.top.find(([i]) => i === id)![1];
    expect(f.seeks).toHaveLength(3);
    for (const s of f.seeks) expect(s.position).toBe(at(s.id));
    expect(f.seeks.map((s) => s.id)).toEqual([WEBM_IDS.Info, WEBM_IDS.Tracks, WEBM_IDS.Cues]);
    // 210 video frames and 350 audio packets: the video ends last (7 s, to the microsecond-rounded frame end).
    const end = Math.max(
      video.at(-1)!.timestampUs + video.at(-1)!.durationUs,
      audio.at(-1)!.timestampUs + audio.at(-1)!.durationUs,
    );
    expect(f.info.duration).toBeCloseTo(end / 1000, 6);
    expect(f.info.duration).toBeGreaterThan(6999);
    expect(f.info.duration).toBeLessThan(7001);
  });

  it('gives the same file however video and audio chunks are fed', () => {
    const a = mux(video, audio, 'interleaved').bytes;
    const b = mux(video, audio, 'video first').bytes;
    const c = mux(video, audio, 'audio first').bytes;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('writes a video-only file', () => {
    const { bytes } = mux(video, []);
    const f = parseWebm(bytes);
    expect(f.tracks).toHaveLength(1);
    expect(f.clusters.flatMap((c) => c.blocks).every((b) => b.track === 1)).toBe(true);
  });

  it('holds back at most the chunks of one track while it waits for the other, and streams clusters out as it goes', () => {
    const mem = memoryWriter();
    const m = new WebmMuxer(mem.w, options());
    let maxPending = 0;
    let ai = 0;
    for (const v of video) {
      m.addVideo(v);
      while (ai < audio.length && audio[ai]!.timestampUs <= v.timestampUs + 40000) m.addAudio(audio[ai++]!);
      maxPending = Math.max(maxPending, m.pending);
    }
    // Interleaved feeding never lets more than a few chunks wait.
    expect(maxPending).toBeLessThan(8);
    // The file is already well under way before finish().
    expect(mem.bytes().length).toBeGreaterThan(video.slice(0, 120).reduce((n, c) => n + c.data.length, 0));
  });

  it('leaves a file that still reads, with an unknown Segment size, when it is cut short', () => {
    const mem = memoryWriter();
    const m = new WebmMuxer(mem.w, options());
    for (const v of video.slice(0, 130)) m.addVideo(v);
    for (const a of audio.slice(0, 220)) m.addAudio(a);
    const f = parseWebm(mem.bytes());
    expect(f.segmentSize).toBeNull();
    expect(f.tracks).toHaveLength(2);
    expect(f.clusters.length).toBeGreaterThanOrEqual(1);
  });

  it('counts an hour of time correctly (long timestamps, and 60 fps)', () => {
    const hour = 3600;
    const v: MuxChunk[] = [];
    for (let i = 0; i < 4; i++) {
      const t = frameTimeUs(hour * 60 + i, 60);
      v.push({
        timestampUs: t,
        durationUs: frameDurationUs(hour * 60 + i, 60),
        key: i === 0,
        data: new Uint8Array([1, 2, 3]),
      });
    }
    const mem = memoryWriter();
    const m = new WebmMuxer(mem.w, { video: { codec: 'V_VP9', width: 640, height: 360, fps: 60 } });
    v.forEach((c) => m.addVideo(c));
    m.finish();
    const f = parseWebm(mem.bytes());
    expect(f.clusters[0]!.timecodeMs).toBe(3_600_000);
    expect(f.clusters[0]!.blocks.map((b) => b.ms)).toEqual(v.map((c) => Math.round(c.timestampUs / 1000)));
    expect(f.tracks[0]!.defaultDuration).toBe(Math.round(1e9 / 60));
  });

  it('does not let a cluster outgrow the 16-bit block offset', () => {
    // No key frames for a minute: the muxer cuts a cluster anyway before offsets overflow.
    const v: MuxChunk[] = Array.from({ length: 60 }, (_, i) => ({
      timestampUs: i * 1_000_000,
      durationUs: 1_000_000,
      key: i === 0,
      data: new Uint8Array([i]),
    }));
    const mem = memoryWriter();
    const m = new WebmMuxer(mem.w, { video: { codec: 'V_VP9', width: 64, height: 64, fps: 1 } });
    v.forEach((c) => m.addVideo(c));
    m.finish();
    const f = parseWebm(mem.bytes());
    expect(f.clusters.length).toBeGreaterThan(1);
    expect(f.clusters.flatMap((c) => c.blocks).map((b) => b.ms)).toEqual(v.map((c) => c.timestampUs / 1000));
  });
});
