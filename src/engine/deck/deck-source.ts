/**
 * Where a deck's audio comes from, read a piece at a time at the context's rate (`DeckStream` fills its window from it):
 *
 *  - `bufferSource`: a song already decoded (the shared sample cache's `AudioBuffer`): a block is a copy, instant.
 *  - `openSegmentSource`: a song too long to decode whole, read from its file by ranges: WAV straight from the
 *    bytes, MP3 by decoding a few seconds of frames at a time (`core/io/audio-segments.ts`), resampled to the context's
 *    rate by `core/audio/resample.ts` position by position, so the blocks join without a seam. Nothing but the pieces
 *    being used is ever in memory.
 *
 * Frames outside the song read as zeros.
 */
import { Resampler } from '@core/audio/resample';
import {
  byteReaderOf,
  indexMp3,
  readWavFrames,
  readWavLayout,
  sniffSegmentFormat,
  type ByteReader,
  type Mp3Layout,
  type WavLayout,
} from '@core/io/audio-segments';

export interface DeckSource {
  /** Length in frames at the context's rate. */
  readonly frames: number;
  readonly sampleRate: number;
  /** 1 or 2 (a mono source gives the same samples on both outputs). */
  readonly channels: 1 | 2;
  /** The file's own length and rate (the overview is drawn from them: no resampling needed). */
  readonly nativeFrames: number;
  readonly nativeRate: number;
  /** `read` finishes at once (the audio is in memory), so `readSync` exists and a window can be filled without waiting. */
  readonly immediate: boolean;
  /** Fills `outL/outR[0..n)` with frames [start, start + n) at the context's rate. */
  read(start: number, n: number, outL: Float32Array, outR: Float32Array): Promise<void>;
  readSync?(start: number, n: number, outL: Float32Array, outR: Float32Array): void;
  /** The same in the file's own rate (the overview and analysis read it). */
  readNative(start: number, n: number, outL: Float32Array, outR: Float32Array): Promise<void>;
  dispose(): void;
}

/** A decoded song as a source (instant; `release` is called on dispose, e.g. to unpin it in the cache). */
export function bufferSource(buffer: AudioBuffer, release?: () => void): DeckSource {
  const frames = buffer.length;
  const stereo = buffer.numberOfChannels > 1;
  const copy = (start: number, n: number, outL: Float32Array, outR: Float32Array) => {
    const have = Math.max(0, Math.min(n, frames - start));
    if (start < 0 || have < n) {
      outL.fill(0, 0, n);
      outR.fill(0, 0, n);
    }
    if (have <= 0) return;
    const at = Math.max(0, start);
    const skip = at - start;
    const m = have - skip;
    if (m <= 0) return;
    const l = buffer.getChannelData(0);
    outL.set(l.subarray(at, at + m), skip);
    outR.set((stereo ? buffer.getChannelData(1) : l).subarray(at, at + m), skip);
  };
  return {
    frames,
    sampleRate: buffer.sampleRate,
    channels: stereo ? 2 : 1,
    nativeFrames: frames,
    nativeRate: buffer.sampleRate,
    immediate: true,
    read: (s, n, l, r) => Promise.resolve(copy(s, n, l, r)),
    readSync: copy,
    readNative: (s, n, l, r) => Promise.resolve(copy(s, n, l, r)),
    dispose: () => release?.(),
  };
}

/** A file's own audio, in pieces. */
interface NativeReader {
  frames: number;
  sampleRate: number;
  channels: 1 | 2;
  /** Fills outL/outR with native frames [start, start + n) (zeros outside the file). */
  read(start: number, n: number, outL: Float32Array, outR: Float32Array): Promise<void>;
}

/** The context-rate view of a native reader: each output frame computed from the file's samples around its exact position. */
function resampled(native: NativeReader, ctxRate: number, dispose: () => void): DeckSource {
  const same = native.sampleRate === ctxRate;
  const rs = same ? null : new Resampler(native.sampleRate, ctxRate);
  const frames = same ? native.frames : Math.round((native.frames * ctxRate) / native.sampleRate);
  return {
    frames,
    sampleRate: ctxRate,
    channels: native.channels,
    nativeFrames: native.frames,
    nativeRate: native.sampleRate,
    immediate: false,
    async read(start, n, outL, outR) {
      if (!rs) return native.read(start, n, outL, outR);
      const { from, to } = rs.need(start, n);
      const l = new Float32Array(to - from);
      const r = native.channels === 2 ? new Float32Array(to - from) : l;
      await native.read(from, to - from, l, r);
      rs.convert(l, from, outL, start, n);
      if (native.channels === 2) rs.convert(r, from, outR, start, n);
      else outR.set(outL.subarray(0, n));
    },
    readNative: (s, n, l, r) => native.read(s, n, l, r),
    dispose,
  };
}

/** Fills the part of `out` that lies in [0, total) from `copy`, zeros elsewhere. */
function zeroOutside(out: Float32Array, start: number, n: number, total: number): { lo: number; hi: number } {
  const lo = Math.max(0, -start);
  const hi = Math.min(n, total - start);
  if (lo > 0) out.fill(0, 0, Math.min(n, lo));
  if (hi < n) out.fill(0, Math.max(0, hi), n);
  return { lo, hi };
}

function wavReader(r: ByteReader, w: WavLayout): NativeReader {
  return {
    frames: w.frames,
    sampleRate: w.sampleRate,
    channels: w.channels > 1 ? 2 : 1,
    async read(start, n, outL, outR) {
      const { lo, hi } = zeroOutside(outL, start, n, w.frames);
      if (outR !== outL) zeroOutside(outR, start, n, w.frames);
      if (hi <= lo) return;
      const [l, rr] = await readWavFrames(r, w, start + lo, hi - lo);
      outL.set(l.subarray(0, hi - lo), lo);
      if (outR !== outL) outR.set((rr ?? l).subarray(0, hi - lo), lo);
    },
  };
}

/** Audio frames per decoded piece of an MP3 (6.7 s at 44.1 kHz), the frames decoded before it to prime the bit reservoir, and how many pieces are kept. */
const MP3_PIECE = 256;
const MP3_LEAD = 4;
const MP3_KEEP = 4;

interface Piece {
  /** Native frame of the first valid sample. */
  start: number;
  /** Valid samples. */
  n: number;
  /** Offset of the first valid sample in the decoded channels. */
  at: number;
  l: Float32Array;
  r: Float32Array;
}

/** What decodes a run of MP3 frames (a valid file of just those frames) at the file's own rate: the browser's `decodeAudioData`. */
export type DecodeBytes = (bytes: Uint8Array, sampleRate: number) => Promise<{ l: Float32Array; r: Float32Array }>;

export function decodeWithAudioContext(): DecodeBytes {
  const ctxs = new Map<number, OfflineAudioContext>();
  return async (bytes, rate) => {
    let ctx = ctxs.get(rate);
    if (!ctx) ctxs.set(rate, (ctx = new OfflineAudioContext(1, 1, rate)));
    // decodeAudioData takes (detaches) its input: give it an exact copy.
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    const l = buf.getChannelData(0);
    return { l, r: buf.numberOfChannels > 1 ? buf.getChannelData(1) : l };
  };
}

function mp3Reader(r: ByteReader, m: Mp3Layout, decode: DecodeBytes): NativeReader {
  const spf = m.samplesPerFrame;
  const pieces = new Map<number, Piece>();
  const loading = new Map<number, Promise<Piece>>();
  const pieceCount = Math.ceil(m.count / MP3_PIECE);
  const load = (c: number): Promise<Piece> => {
    const hit = pieces.get(c);
    if (hit) {
      // Most recently used goes last.
      pieces.delete(c);
      pieces.set(c, hit);
      return Promise.resolve(hit);
    }
    let p = loading.get(c);
    if (!p) {
      p = (async () => {
        const f0 = Math.max(0, c * MP3_PIECE - MP3_LEAD);
        const f1 = Math.min(m.count, (c + 1) * MP3_PIECE);
        const bytes = await r.read(m.offsets[f0] as number, (m.offsets[f1] as number) - (m.offsets[f0] as number));
        const first = c * MP3_PIECE;
        let l: Float32Array;
        let rr: Float32Array;
        try {
          ({ l, r: rr } = await decode(bytes, m.sampleRate));
        } catch (e) {
          console.warn('Can’t decode a stretch of the song', e);
          l = rr = new Float32Array((f1 - f0) * spf);
        }
        const piece: Piece = {
          // Fragment sample j is song sample f0 × spf + j − skip; the piece is what comes from its own frames.
          start: first * spf - m.skip,
          n: (f1 - first) * spf,
          at: (first - f0) * spf,
          l,
          r: rr,
        };
        pieces.set(c, piece);
        while (pieces.size > MP3_KEEP) pieces.delete(pieces.keys().next().value as number);
        return piece;
      })().finally(() => loading.delete(c));
      loading.set(c, p);
    }
    return p;
  };
  return {
    frames: m.frames,
    sampleRate: m.sampleRate,
    channels: m.channels > 1 ? 2 : 1,
    async read(start, n, outL, outR) {
      const { lo, hi } = zeroOutside(outL, start, n, m.frames);
      if (outR !== outL) zeroOutside(outR, start, n, m.frames);
      if (hi <= lo) return;
      let o = lo;
      while (o < hi) {
        const pos = start + o + m.skip;
        const c = Math.min(pieceCount - 1, Math.floor(pos / (MP3_PIECE * spf)));
        const piece = await load(c);
        const from = start + o - piece.start;
        const take = Math.min(hi - o, piece.n - from);
        if (take <= 0) break;
        outL.set(piece.l.subarray(piece.at + from, piece.at + from + take), o);
        if (outR !== outL) outR.set(piece.r.subarray(piece.at + from, piece.at + from + take), o);
        o += take;
      }
    },
  };
}

export interface SegmentOptions {
  reader: ByteReader;
  /** The audio context's rate: the source converts to it. */
  sampleRate: number;
  decode?: DecodeBytes;
  yieldNow?: () => Promise<void>;
}

/**
 * A source read by ranges from a file, or null when the file isn't a format that can be (the caller decodes it whole).
 * Opening an MP3 reads through the whole file once for the frame offsets (a hop per frame; a second or two for two hours).
 */
export async function openSegmentSource(o: SegmentOptions): Promise<DeckSource | null> {
  const head = await o.reader.read(0, 64);
  const format = sniffSegmentFormat(head);
  if (format === 'wav') {
    const w = await readWavLayout(o.reader);
    return w ? resampled(wavReader(o.reader, w), o.sampleRate, () => {}) : null;
  }
  if (format === 'mp3') {
    const m = await indexMp3(o.reader, o.yieldNow);
    return m ? resampled(mp3Reader(o.reader, m, o.decode ?? decodeWithAudioContext()), o.sampleRate, () => {}) : null;
  }
  return null;
}

export { byteReaderOf };

/** A file or blob as a byte reader. */
export function blobReader(blob: Blob): ByteReader {
  return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}
