/**
 * Reading an audio file a piece at a time, pure (no DOM; Node, Worker or main thread), for songs too long to decode in
 * one go (a 2-hour mix is 2.7 GB as floats). The browser can't decode part of a compressed file, but it can decode a
 * file that is only part of one, so what is needed is where the parts are:
 *
 *  - WAV: the `fmt ` and `data` chunks give every frame's byte position; a piece is a few frames' bytes behind the
 *    file's own header and `decodePcm` reads it (every format it knows: 8/16/24/32-bit, float, extensible).
 *  - MP3: every frame is self-contained but for the bit reservoir (a frame may use up to 511 bytes of the frames before
 *    it), so a run of frames starting a few frames early decodes exactly from its second frame on. `indexMp3` finds
 *    where each frame starts (one pass of header reads, ~1 MB of offsets for a 2-hour file) and the gapless trim
 *    LAME's tag asks for (encoder delay + 529 samples dropped from the start).
 *
 * Other formats (AAC in M4A, Ogg, FLAC) return null here and are decoded whole by the caller.
 */
import { mpegFrameAt } from './audio-info';
import { decodePcm } from './wav';

/** A file read by ranges (a Blob/File from the origin-private file system, or anything that can slice). */
export interface ByteReader {
  readonly size: number;
  /** `length` bytes from `offset` (fewer at the end of the file). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function byteReaderOf(bytes: Uint8Array): ByteReader {
  return { size: bytes.length, read: (o, n) => Promise.resolve(bytes.subarray(o, Math.min(bytes.length, o + n))) };
}

export type SegmentFormat = 'wav' | 'mp3';

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

/** The format of a file from its first bytes: WAV/RF64, or MPEG audio (ID3 tag or a frame header first); null for the rest. */
export function sniffSegmentFormat(head: Uint8Array): SegmentFormat | null {
  if (head.length < 12) return null;
  const t = tag(head, 0);
  if ((t === 'RIFF' || t === 'RF64') && tag(head, 8) === 'WAVE') return 'wav';
  if (t.startsWith('ID3') || (head[0] === 0xff && ((head[1] as number) & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

// ---------------------------------------------------------------------------------------------
// WAV

export interface WavLayout {
  sampleRate: number;
  channels: number;
  /** Bytes per frame. */
  blockAlign: number;
  /** Where the first frame is, and how many there are. */
  dataOffset: number;
  frames: number;
  /** The file up to the first frame (RIFF header, `fmt `, …, the `data` chunk header): what a piece is put behind to be read. */
  head: Uint8Array;
}

/** The layout of a WAV/RF64 file, or null when it isn't one `decodePcm` reads (ADPCM, …). */
export async function readWavLayout(r: ByteReader): Promise<WavLayout | null> {
  const first = await r.read(0, 12);
  const form = tag(first, 0);
  if ((form !== 'RIFF' && form !== 'RF64') || tag(first, 8) !== 'WAVE') return null;
  let o = 12;
  let rate = 0;
  let channels = 0;
  let blockAlign = 0;
  let ds64 = -1;
  // Walk the chunk headers (a metadata chunk before the audio can be megabytes: skip it by its size).
  while (o + 8 <= r.size) {
    const h = await r.read(o, 8);
    if (h.length < 8) return null;
    const v = new DataView(h.buffer, h.byteOffset, 8);
    const id = tag(h, 0);
    const size = v.getUint32(4, true);
    if (id === 'ds64') {
      const b = await r.read(o + 8, 28);
      if (b.length >= 16) ds64 = Number(new DataView(b.buffer, b.byteOffset, b.length).getBigUint64(8, true));
    } else if (id === 'fmt ') {
      const b = await r.read(o + 8, Math.min(size, 40));
      if (b.length < 16) return null;
      const f = new DataView(b.buffer, b.byteOffset, b.length);
      channels = f.getUint16(2, true);
      rate = f.getUint32(4, true);
      blockAlign = f.getUint16(12, true);
    } else if (id === 'data') {
      if (!rate || !channels || !blockAlign) return null;
      const dataOffset = o + 8;
      // A streamed or crashed writer leaves the size wrong: never count past the end of the file.
      const declared = size === 0xffffffff && ds64 >= 0 ? ds64 : size;
      const bytes = Math.min(declared, r.size - dataOffset);
      const frames = Math.floor(bytes / blockAlign);
      if (frames <= 0) return null;
      const head = await r.read(0, dataOffset);
      // Does `decodePcm` read this format? One frame tells (it returns null for ADPCM, µ-law, …).
      const probe = new Uint8Array(head.length + blockAlign);
      probe.set(head);
      if (!decodePcm(probe)) return null;
      return { sampleRate: rate, channels, blockAlign, dataOffset, frames, head };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/** Frames [start, start + n) of a WAV as float channels (at most two; a mono file gives the same array twice). */
export async function readWavFrames(r: ByteReader, w: WavLayout, start: number, n: number): Promise<[Float32Array, Float32Array]> {
  const a = Math.max(0, Math.min(w.frames, start));
  const b = Math.max(a, Math.min(w.frames, start + n));
  const body = await r.read(w.dataOffset + a * w.blockAlign, (b - a) * w.blockAlign);
  const bytes = new Uint8Array(w.head.length + body.length);
  bytes.set(w.head);
  bytes.set(body, w.head.length);
  const pcm = decodePcm(bytes);
  const l = pcm?.channels[0] ?? new Float32Array(0);
  return [l, pcm?.channels[1] ?? l];
}

// ---------------------------------------------------------------------------------------------
// MP3

export interface Mp3Layout {
  sampleRate: number;
  channels: number;
  /** 1152 (MPEG-1 Layer III) or 576. */
  samplesPerFrame: number;
  /** Audio frames (the Xing/Info frame is not one). */
  count: number;
  /** Byte offset of each audio frame, and of the end of the last at `[count]`. */
  offsets: Float64Array;
  /** Samples a whole-file decoder drops from the start (encoder delay + its own 529 with LAME's tag), and the length it ends up with. */
  skip: number;
  frames: number;
}

/** MPEG-1 Layer III decoders add 529 samples of their own delay. */
export const MP3_DECODER_DELAY = 529;
const SCAN_CHUNK = 4 * 1024 * 1024;

/**
 * Where every frame of an MP3 starts, found by reading the headers (frame length from the bit rate, rate and padding),
 * resynchronizing over damage and stopping at trailing tags. Null for anything that isn't Layer III with a steady
 * rate and channel mode. `yieldNow` is awaited between chunks so a long file doesn't hold the page.
 */
export async function indexMp3(r: ByteReader, yieldNow: () => Promise<void> = () => Promise.resolve()): Promise<Mp3Layout | null> {
  // The start of the audio: past ID3v2 tags.
  let abs = 0;
  for (;;) {
    const h = await r.read(abs, 10);
    if (h.length < 10 || !tag(h, 0).startsWith('ID3')) break;
    const size = (((h[6] as number) & 0x7f) << 21) | (((h[7] as number) & 0x7f) << 14) | (((h[8] as number) & 0x7f) << 7) | ((h[9] as number) & 0x7f);
    abs += 10 + size + ((h[5] as number) & 0x10 ? 10 : 0);
  }
  const offs: number[] = [];
  let rate = 0;
  let channels = 0;
  let spf = 0;
  let delay = 0;
  let padding = 0;
  let lame = false;
  let expectedEnd = -1;
  let buf: Uint8Array = new Uint8Array(0);
  let bufAt = -1;
  /** Bytes a frame and the header after it need. */
  const NEED = 2048;
  let lost = 0;
  while (abs + 4 <= r.size) {
    // The window holds [abs, abs + NEED) (or runs to the end of the file).
    if (!(bufAt >= 0 && abs >= bufAt && (abs + NEED <= bufAt + buf.length || bufAt + buf.length >= r.size))) {
      await yieldNow();
      buf = await r.read(abs, SCAN_CHUNK);
      bufAt = abs;
      if (buf.length < 4) break;
    }
    const p = abs - bufAt;
    const f = mpegFrameAt(buf, p);
    // Two headers in a row make a frame (a lone sync pattern in a tag or in damaged data is no proof).
    let ok = f !== null && f.layer === 3 && (rate === 0 || (f.rate === rate && f.channels === channels)) && abs + (f?.length ?? 0) <= r.size;
    // The first frame, and any frame found by searching (after damage or at a tag), must be followed by another.
    if (ok && f && (rate === 0 || lost > 0) && p + f.length + 4 <= buf.length) ok = mpegFrameAt(buf, p + f.length) !== null;
    if (!ok || !f) {
      // Not a frame: damage, or a trailing tag (ID3v1 'TAG', APE). Resynchronize a little further on, else it is the end.
      if (offs.length > 0 && lost > 8192) break;
      abs += 1;
      lost++;
      continue;
    }
    lost = 0;
    if (rate === 0) {
      rate = f.rate;
      channels = f.channels;
      spf = f.samples;
      if (f.version !== 1 && f.version !== 2) return null;
      // The first frame may be the Xing/Info frame: silent, not audio, and it may carry LAME's gapless numbers.
      const side = f.version === 1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
      const x = p + 4 + side;
      const xt = tag(buf, x);
      if (xt === 'Xing' || xt === 'Info') {
        const flags = new DataView(buf.buffer, buf.byteOffset, buf.length).getUint32(x + 4);
        const q = x + 8 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
        const lt = tag(buf, q);
        if (lt.startsWith('LAME') || lt.startsWith('Lavc') || lt.startsWith('Lavf')) {
          lame = true;
          delay = ((buf[q + 21] as number) << 4) | ((buf[q + 22] as number) >> 4);
          padding = (((buf[q + 22] as number) & 0x0f) << 8) | (buf[q + 23] as number);
        }
        abs += f.length;
        continue;
      }
    }
    offs.push(abs);
    abs += f.length;
    expectedEnd = abs;
  }
  if (offs.length < 2 || rate === 0) return null;
  const count = offs.length;
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i] = offs[i] as number;
  offsets[count] = expectedEnd;
  const skip = lame ? delay + MP3_DECODER_DELAY : 0;
  const frames = Math.max(0, count * spf - (lame ? delay + padding : 0));
  return { sampleRate: rate, channels, samplesPerFrame: spf, count, offsets, skip, frames };
}
