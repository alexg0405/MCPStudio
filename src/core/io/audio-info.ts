/**
 * Duration, sample rate and channels of an audio file from its headers, without decoding it
 * (decoding a 5-minute MP3 just to learn its length takes ~0.5 s and ~115 MB). Pure; reads:
 *
 * - WAV (fmt + data size), AIFF/AIFC (COMM), FLAC (STREAMINFO);
 * - MP3: the Xing/Info or VBRI header's frame count (with LAME's encoder delay and padding), else
 *   every frame header counted (a hop per frame: cheap even for an hour);
 * - AAC in ADTS (frame headers counted), M4A/MP4 (the sound track's `mdhd`, else `mvhd`, and the
 *   `mp4a`/`alac`/… sample entry);
 * - OGG Vorbis/Opus (the identification header and the last page's granule position).
 *
 * Returns null when it can't tell (the caller decodes then).
 */

export type AudioFormat = 'wav' | 'aiff' | 'flac' | 'mp3' | 'aac' | 'm4a' | 'ogg';

/**
 * What the headers of an audio file say: its format, length in seconds, sample rate (Hz) and channels, and whether the
 * length is exact.
 */
export interface AudioInfo {
  format: AudioFormat;
  durationSec: number;
  /** The file's own rate (Opus: 48 kHz, what it decodes at). */
  sampleRate: number;
  channels: number;
  /**
   * False when the duration is an estimate within a frame or two (MP3 without LAME's gapless info,
   * AAC's encoder priming): a decode gives the exact length.
   */
  exact: boolean;
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

function viewOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Reads an audio file's `AudioInfo` from its header bytes without decoding it; null when the format is not recognised
 * or the header is unreadable.
 */
export function readAudioInfo(bytes: Uint8Array): AudioInfo | null {
  try {
    if (bytes.length < 12) return null;
    const t0 = tag(bytes, 0);
    const t8 = tag(bytes, 8);
    if ((t0 === 'RIFF' || t0 === 'RF64') && t8 === 'WAVE') return wavInfo(bytes);
    if (t0 === 'FORM' && (t8 === 'AIFF' || t8 === 'AIFC')) return aiffInfo(bytes);
    if (tag(bytes, 4) === 'ftyp') return mp4Info(bytes);
    if (t0 === 'OggS') return oggInfo(bytes);
    const start = skipId3(bytes);
    if (tag(bytes, start) === 'fLaC') return flacInfo(bytes, start);
    return mpegInfo(bytes, start);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- WAV, AIFF, FLAC

function wavInfo(b: Uint8Array): AudioInfo | null {
  const v = viewOf(b);
  let o = 12;
  let channels = 0;
  let rate = 0;
  let blockAlign = 0;
  let dataSize = -1;
  let ds64 = -1;
  while (o + 8 <= b.length) {
    const id = tag(b, o);
    const size = v.getUint32(o + 4, true);
    if (id === 'ds64' && o + 8 + 16 <= b.length) ds64 = Number(v.getBigUint64(o + 8 + 8, true));
    if (id === 'fmt ' && o + 8 + 16 <= b.length) {
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      blockAlign = v.getUint16(o + 20, true);
    }
    if (id === 'data') {
      const declared = size === 0xffffffff && ds64 >= 0 ? ds64 : size;
      // A streamed or crashed writer leaves the size wrong: never count past the end of the file.
      dataSize = Math.min(declared, b.length - (o + 8));
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!channels || !rate || !blockAlign || dataSize < 0) return null;
  const frames = Math.floor(dataSize / blockAlign);
  return { format: 'wav', durationSec: frames / rate, sampleRate: rate, channels, exact: true };
}

/** An 80-bit IEEE 754 extended float (AIFF's sample rate). */
function readExtended(v: DataView, o: number): number {
  const se = v.getUint16(o);
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  const sign = se & 0x8000 ? -1 : 1;
  const exp = (se & 0x7fff) - 16383 - 63;
  return sign * (hi * 2 ** 32 + lo) * 2 ** exp;
}

function aiffInfo(b: Uint8Array): AudioInfo | null {
  const v = viewOf(b);
  let o = 12;
  while (o + 8 <= b.length) {
    const id = tag(b, o);
    const size = v.getUint32(o + 4);
    if (id === 'COMM' && o + 8 + 18 <= b.length) {
      const channels = v.getInt16(o + 8);
      const frames = v.getUint32(o + 10);
      const rate = readExtended(v, o + 16);
      if (channels <= 0 || !(rate > 0)) return null;
      return { format: 'aiff', durationSec: frames / rate, sampleRate: rate, channels, exact: true };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

function flacInfo(b: Uint8Array, start: number): AudioInfo | null {
  // The first metadata block is STREAMINFO (type 0, 34 bytes).
  const o = start + 4;
  if ((b[o]! & 0x7f) !== 0 || o + 4 + 18 > b.length) return null;
  const s = o + 4 + 10;
  const rate = (b[s]! << 12) | (b[s + 1]! << 4) | (b[s + 2]! >> 4);
  const channels = ((b[s + 2]! >> 1) & 7) + 1;
  const total =
    (b[s + 3]! & 0x0f) * 2 ** 32 + ((b[s + 4]! << 24) >>> 0) + (b[s + 5]! << 16) + (b[s + 6]! << 8) + b[s + 7]!;
  if (!rate || total === 0) return null; // 0 = unknown length (a stream)
  return { format: 'flac', durationSec: total / rate, sampleRate: rate, channels, exact: true };
}

// ---------------------------------------------------------------- MP3 and ADTS AAC

function skipId3(b: Uint8Array): number {
  let o = 0;
  // Some files carry more than one ID3v2 tag.
  while (tag(b, o).startsWith('ID3') && o + 10 <= b.length) {
    const size =
      ((b[o + 6]! & 0x7f) << 21) | ((b[o + 7]! & 0x7f) << 14) | ((b[o + 8]! & 0x7f) << 7) | (b[o + 9]! & 0x7f);
    o += 10 + size + (b[o + 5]! & 0x10 ? 10 : 0);
  }
  return o;
}

const MPEG_RATES = [44100, 48000, 32000];
const BITRATES: Record<string, number[]> = {
  // [version 1 | 2][layer 1..3]
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

interface MpegFrame {
  /** 1 = MPEG-1, 2 = MPEG-2, 2.5 = MPEG-2.5 */
  version: number;
  layer: number;
  rate: number;
  channels: number;
  length: number;
  samples: number;
}

/** The MPEG audio frame header at `o`, or null. */
export function mpegFrameAt(b: Uint8Array, o: number): MpegFrame | null {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1]! & 0xe0) !== 0xe0) return null;
  const vBits = (b[o + 1]! >> 3) & 3;
  const lBits = (b[o + 1]! >> 1) & 3;
  const brIdx = b[o + 2]! >> 4;
  const srIdx = (b[o + 2]! >> 2) & 3;
  if (vBits === 1 || lBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const version = vBits === 3 ? 1 : vBits === 2 ? 2 : 2.5;
  const layer = 4 - lBits;
  const kbps = BITRATES[`${version === 1 ? 1 : 2}-${layer}`]![brIdx]!;
  const rate = MPEG_RATES[srIdx]! / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const pad = (b[o + 2]! >> 1) & 1;
  const channels = b[o + 3]! >> 6 === 3 ? 1 : 2;
  let length: number;
  let samples: number;
  if (layer === 1) {
    length = (Math.floor((12000 * kbps) / rate) + pad) * 4;
    samples = 384;
  } else if (layer === 2 || version === 1) {
    length = Math.floor((144000 * kbps) / rate) + pad;
    samples = 1152;
  } else {
    length = Math.floor((72000 * kbps) / rate) + pad;
    samples = 576;
  }
  return length >= 4 ? { version, layer, rate, channels, length, samples } : null;
}

/** How far into the file the first MPEG frame is searched for, in bytes. */
const FIRST_FRAME_SEARCH_BYTES = 64 * 1024;
/** Bytes of an MPEG frame header. */
const MPEG_HEADER_BYTES = 4;
/** Where the VBRI header sits in the first frame: always 32 bytes after the frame header, so 36 from its start. */
const VBRI_OFFSET = 36;
const VBRI_MIN_BYTES = 18;
/** Xing/Info flag bits: which optional fields follow (frame count, byte count, 100-byte seek table, quality). */
const XING_HAS_FRAMES = 1;
const XING_HAS_BYTES = 2;
const XING_HAS_TOC = 4;
const XING_HAS_QUALITY = 8;
const XING_TOC_BYTES = 100;
/** LAME's tag: the encoder delay and padding (12 bits each) start this far into it. */
const LAME_DELAY_OFFSET = 21;
/** How far past a broken frame the frame scan looks for the next one before giving up. */
const RESYNC_SEARCH_BYTES = 4096;

/** The first frame: two valid headers in a row (a lone 0xFF 0xE? in a tag is no proof). Null when there is none. */
function findFirstMpegFrame(b: Uint8Array, start: number): { frame: MpegFrame; at: number } | null {
  const end = Math.min(b.length, start + FIRST_FRAME_SEARCH_BYTES);
  for (let at = start; at < end; at++) {
    const frame = mpegFrameAt(b, at);
    if (frame && (at + frame.length >= b.length || mpegFrameAt(b, at + frame.length))) return { frame, at };
  }
  return null;
}

function mpegInfo(b: Uint8Array, start: number): AudioInfo | null {
  const found = findFirstMpegFrame(b, start);
  if (!found) return adtsInfo(b, start);
  const { frame: first, at } = found;
  // Xing/Info (VBR and LAME CBR) after the side info, or VBRI 32 bytes in.
  return xingInfo(b, at, first) ?? vbriInfo(b, at, first) ?? countedFramesInfo(b, at, first);
}

/** Duration from a Xing/Info header (frame count, with LAME's delay and padding when present), or null. */
function xingInfo(b: Uint8Array, frameAt: number, first: MpegFrame): AudioInfo | null {
  const sideInfoBytes = first.version === 1 ? (first.channels === 1 ? 17 : 32) : first.channels === 1 ? 9 : 17;
  const x = frameAt + MPEG_HEADER_BYTES + sideInfoBytes;
  const xingTag = tag(b, x);
  if ((xingTag !== 'Xing' && xingTag !== 'Info') || x + 8 > b.length) return null;
  const v = viewOf(b);
  const flags = v.getUint32(x + 4);
  if (!(flags & XING_HAS_FRAMES)) return null;
  const frames = v.getUint32(x + 8);
  let p =
    x +
    8 +
    (flags & XING_HAS_FRAMES ? 4 : 0) +
    (flags & XING_HAS_BYTES ? 4 : 0) +
    (flags & XING_HAS_TOC ? XING_TOC_BYTES : 0) +
    (flags & XING_HAS_QUALITY ? 4 : 0);
  // LAME's tag: encoder delay and padding (12 bits each, 21 bytes into it), so the length is exact.
  let delay = 0;
  let padding = 0;
  let isExact = false;
  const encoderTag = tag(b, p);
  if (encoderTag.startsWith('LAME') || encoderTag.startsWith('Lavc') || encoderTag.startsWith('Lavf')) {
    p += LAME_DELAY_OFFSET;
    if (p + 3 <= b.length) {
      delay = (b[p]! << 4) | (b[p + 1]! >> 4);
      padding = ((b[p + 1]! & 0x0f) << 8) | b[p + 2]!;
      isExact = true;
    }
  }
  // The Xing frame itself is silent and not counted by it.
  const total = Math.max(0, frames * first.samples - delay - padding);
  return {
    format: 'mp3',
    durationSec: total / first.rate,
    sampleRate: first.rate,
    channels: first.channels,
    exact: isExact,
  };
}

/** Duration from a Fraunhofer VBRI header, or null. */
function vbriInfo(b: Uint8Array, frameAt: number, first: MpegFrame): AudioInfo | null {
  if (tag(b, frameAt + VBRI_OFFSET) !== 'VBRI' || frameAt + VBRI_OFFSET + VBRI_MIN_BYTES > b.length) return null;
  const v = viewOf(b);
  const delay = v.getUint16(frameAt + VBRI_OFFSET + 6);
  const frames = v.getUint32(frameAt + VBRI_OFFSET + 14);
  const total = Math.max(0, frames * first.samples - delay);
  return {
    format: 'mp3',
    durationSec: total / first.rate,
    sampleRate: first.rate,
    channels: first.channels,
    exact: false,
  };
}

/** No header: count the frames, resynchronizing over damage and stopping at a trailing tag. */
function countedFramesInfo(b: Uint8Array, firstFrameAt: number, first: MpegFrame): AudioInfo {
  let frames = 0;
  let p = firstFrameAt;
  while (p < b.length) {
    const f = mpegFrameAt(b, p);
    if (!f) {
      // A broken frame or a trailing tag (ID3v1 'TAG', APE): resynchronize a little further on.
      let q = p + 1;
      const end = Math.min(b.length, p + RESYNC_SEARCH_BYTES);
      while (q < end && !mpegFrameAt(b, q)) q++;
      if (q >= end) break;
      p = q;
      continue;
    }
    frames++;
    p += f.length;
  }
  return {
    format: 'mp3',
    durationSec: (frames * first.samples) / first.rate,
    sampleRate: first.rate,
    channels: first.channels,
    exact: false,
  };
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function adtsInfo(b: Uint8Array, start: number): AudioInfo | null {
  let p = start;
  let frames = 0;
  let rate = 0;
  let channels = 0;
  while (p + 7 <= b.length) {
    if (b[p] !== 0xff || (b[p + 1]! & 0xf6) !== 0xf0) {
      if (frames === 0 && p < start + 64 * 1024) {
        p++;
        continue;
      }
      break;
    }
    const srIdx = (b[p + 2]! >> 2) & 0x0f;
    const ch = ((b[p + 2]! & 1) << 2) | (b[p + 3]! >> 6);
    const len = ((b[p + 3]! & 3) << 11) | (b[p + 4]! << 3) | (b[p + 5]! >> 5);
    const blocks = (b[p + 6]! & 3) + 1;
    if (len < 7 || srIdx >= ADTS_RATES.length) break;
    if (frames === 0) {
      rate = ADTS_RATES[srIdx]!;
      channels = ch === 7 ? 8 : ch || 2;
    }
    frames += blocks;
    p += len;
  }
  if (frames === 0 || !rate) return null;
  return { format: 'aac', durationSec: (frames * 1024) / rate, sampleRate: rate, channels, exact: false };
}

// ---------------------------------------------------------------- MP4 / M4A

interface Box {
  type: string;
  start: number;
  /** Payload start and end. */
  body: number;
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const v = viewOf(b);
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = v.getUint32(o);
    let body = o + 8;
    if (size === 1 && o + 16 <= to) {
      size = Number(v.getBigUint64(o + 8));
      body = o + 16;
    } else if (size === 0) size = to - o;
    if (size < body - o) break;
    out.push({ type: tag(b, o + 4), start: o, body, end: Math.min(to, o + size) });
    o += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box | undefined, type: string, skip = 0) =>
  box ? boxes(b, box.body + skip, box.end).find((c) => c.type === type) : undefined;

/** mvhd/mdhd: [timescale, duration]. */
function headerTimes(b: Uint8Array, box: Box): [number, number] {
  const v = viewOf(b);
  const version = b[box.body]!;
  return version === 1
    ? [v.getUint32(box.body + 20), Number(v.getBigUint64(box.body + 24))]
    : [v.getUint32(box.body + 12), v.getUint32(box.body + 16)];
}

function mp4Info(b: Uint8Array): AudioInfo | null {
  const top = boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return null;
  const v = viewOf(b);
  let duration = 0;
  let rate = 0;
  let channels = 0;
  for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia');
    const hdlr = child(b, mdia, 'hdlr');
    if (!hdlr || tag(b, hdlr.body + 8) !== 'soun') continue;
    const mdhd = child(b, mdia, 'mdhd');
    if (mdhd) {
      const [scale, d] = headerTimes(b, mdhd);
      if (scale > 0) duration = d / scale;
    }
    const stsd = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stsd');
    // stsd: version/flags (4), entry count (4), then the sample entries.
    const entry = stsd ? boxes(b, stsd.body + 8, stsd.end)[0] : undefined;
    if (entry && entry.body + 28 <= b.length) {
      channels = v.getUint16(entry.body + 16);
      rate = v.getUint32(entry.body + 24) >>> 16;
    }
    break;
  }
  if (!duration) {
    const mvhd = child(b, moov, 'mvhd');
    if (mvhd) {
      const [scale, d] = headerTimes(b, mvhd);
      if (scale > 0) duration = d / scale;
    }
  }
  if (!(duration > 0) || !rate || !channels) return null;
  return { format: 'm4a', durationSec: duration, sampleRate: rate, channels, exact: false };
}

// ---------------------------------------------------------------- OGG

function oggInfo(b: Uint8Array): AudioInfo | null {
  const v = viewOf(b);
  if (b.length < 28) return null;
  const serial = v.getUint32(14, true);
  const segs = b[26]!;
  const data = 27 + segs;
  let rate: number;
  let channels: number;
  let preSkip = 0;
  if (b[data] === 1 && String.fromCharCode(...b.subarray(data + 1, data + 7)) === 'vorbis') {
    channels = b[data + 11]!;
    rate = v.getUint32(data + 12, true);
  } else if (String.fromCharCode(...b.subarray(data, data + 8)) === 'OpusHead') {
    channels = b[data + 9]!;
    preSkip = v.getUint16(data + 10, true);
    rate = 48000;
  } else return null;
  // The last page of this stream carries the total in its granule position.
  for (let o = b.length - 27; o >= 0; o--) {
    if (b[o] !== 0x4f || tag(b, o) !== 'OggS' || v.getUint32(o + 14, true) !== serial) continue;
    const granule = Number(v.getBigInt64(o + 6, true));
    if (granule < 0) continue;
    const frames = Math.max(0, granule - preSkip);
    return { format: 'ogg', durationSec: frames / rate, sampleRate: rate, channels, exact: true };
  }
  return null;
}
