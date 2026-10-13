/**
 * WAV export encoding, plus a small PCM decoder for WAV and AIFF/AIFC. Chrome's decodeAudioData
 * can't read AIFF, so this is the fallback (it also reads the root key and loop points that
 * decodeAudioData drops). Pure TypeScript, no DOM; runs in Node, the main thread or a Worker.
 */

export type WavBitDepth = 16 | 24 | 32;

export interface EncodeWavOptions {
  /** 16/24 = integer PCM, 32 = IEEE float. */
  bitDepth: WavBitDepth;
  /** TPDF dither before quantizing (16-bit only; 24-bit and float are written undithered). */
  dither?: boolean;
  /** Seed for the dither noise. The same input and seed always produce the same bytes. */
  seed?: number;
}

export interface DecodedPcm {
  /** The file's own rate (no resampling happens here). */
  sampleRate: number;
  /** One array per channel, nominally in [-1, 1). */
  channels: Float32Array[];
  /** Sustain loop in frames, `end` exclusive (from WAV `smpl` or AIFF `INST` + `MARK`). */
  loop?: { start: number; end: number };
  /** MIDI note at which the sample plays at its original pitch (WAV `smpl` unity note, AIFF `INST` base note). */
  rootKey?: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** Bytes 2..15 of every KSDATAFORMAT_SUBTYPE_* GUID ({0000xxxx-0000-0010-8000-00aa00389b71}). */
const KSDATAFORMAT_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
const DEFAULT_DITHER_SEED = 0x2545f491;
const MAX_RIFF_SIZE = 0xffffffff;

// ---------------------------------------------------------------------------------------------
// Encoding

/**
 * Encodes interleaved RIFF/WAVE: PCM integers for 16/24-bit, IEEE float (with a `fact` chunk) for
 * 32-bit. Samples are clipped to [-1, 1] and NaN becomes 0. Integers use a 2^(bits-1) scale with
 * rounding, so decoding by the same scale is accurate to half a step (one step at +1.0).
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, opts: EncodeWavOptions): Uint8Array {
  const numChannels = channels.length;
  if (numChannels < 1 || numChannels > 0xffff) throw new RangeError('encodeWav needs between 1 and 65535 channels.');
  const frames = (channels[0] as Float32Array).length;
  if (channels.some((c) => c.length !== frames))
    throw new RangeError('encodeWav: all channels must have the same length.');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 0xffffffff) {
    throw new RangeError(`encodeWav: invalid sample rate ${sampleRate}.`);
  }
  const { bitDepth } = opts;
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) throw new RangeError(`encodeWav: unsupported bit depth.`);

  const isFloat = bitDepth === 32;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const fmtSize = isFloat ? 18 : 16; // WAVEFORMATEX with cbSize = 0 for non-PCM formats
  const headerSize = 12 + 8 + fmtSize + (isFloat ? 12 : 0) + 8;
  const total = headerSize + dataSize + (dataSize & 1);
  if (total - 8 > MAX_RIFF_SIZE) throw new RangeError('encodeWav: the audio is too long for a WAV file (4 GiB).');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  writeTag(out, 0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeTag(out, 8, 'WAVE');
  writeTag(out, 12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * blockAlign) % 0x100000000, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  let o = 36;
  if (isFloat) {
    view.setUint16(o, 0, true); // cbSize
    o += 2;
    writeTag(out, o, 'fact');
    view.setUint32(o + 4, 4, true);
    view.setUint32(o + 8, frames, true);
    o += 12;
  }
  writeTag(out, o, 'data');
  view.setUint32(o + 4, dataSize, true);
  o += 8;

  if (bitDepth === 16) {
    const rand = opts.dither ? mulberry32(opts.seed ?? DEFAULT_DITHER_SEED) : null;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        let s = clip((channels[c] as Float32Array)[i] as number) * 32768;
        if (rand) s += rand() - rand(); // TPDF: triangular noise in (-1, 1) LSB
        s = Math.round(s);
        view.setInt16(o, s > 32767 ? 32767 : s < -32768 ? -32768 : s, true);
        o += 2;
      }
    }
  } else if (bitDepth === 24) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        let s = Math.round(clip((channels[c] as Float32Array)[i] as number) * 8388608);
        if (s > 8388607) s = 8388607;
        out[o] = s & 0xff;
        out[o + 1] = (s >> 8) & 0xff;
        out[o + 2] = (s >> 16) & 0xff;
        o += 3;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        view.setFloat32(o, clip((channels[c] as Float32Array)[i] as number), true);
        o += 4;
      }
    }
  }
  return out;
}

function clip(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x === x ? x : 0;
}

/** Seeded uniform [0, 1) generator (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Decoding

type SampleKind = 'uint' | 'int' | 'float';

interface PcmLayout {
  kind: SampleKind;
  /** Bytes per sample in the stream (the container; narrower samples are left-justified). */
  width: number;
  littleEndian: boolean;
  channels: number;
  /** Bytes per frame (≥ channels × width). */
  frameBytes: number;
}

interface Chunk {
  id: string;
  /** Payload offset. */
  start: number;
  /** Payload size, clamped to the bytes actually present. */
  size: number;
}

/**
 * Decodes uncompressed WAV (PCM 8/16/24/32-bit, float 32/64, WAVE_FORMAT_EXTENSIBLE) and AIFF/AIFC
 * (`NONE`/`twos`, `sowt`, `fl32`/`FL32`, `fl64`/`FL64`). Returns null for anything else (other
 * containers, compressed codecs, missing format or data chunks). Truncated files decode the frames
 * that are present.
 */
export function decodePcm(bytes: Uint8Array): DecodedPcm | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = readTag(bytes, 0);
  const form = readTag(bytes, 8);
  if (riff === 'RIFF' && form === 'WAVE') return decodeWav(bytes, view);
  if (riff === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return decodeAiff(bytes, view, form === 'AIFC');
  return null;
}

function readChunks(bytes: Uint8Array, view: DataView, littleEndian: boolean): Chunk[] {
  const chunks: Chunk[] = [];
  let o = 12;
  // The RIFF/FORM size field is often wrong in the wild (streamed or crashed writers), so walk the
  // chunks up to the end of the buffer instead.
  while (o + 8 <= bytes.length) {
    const declared = view.getUint32(o + 4, littleEndian);
    const start = o + 8;
    chunks.push({ id: readTag(bytes, o), start, size: Math.min(declared, bytes.length - start) });
    const end = start + declared;
    // Odd-sized chunks are followed by a zero pad byte, but some writers leave it out. A chunk id is
    // four printable characters, so a non-zero byte that starts one means the pad is missing.
    o = declared & 1 && bytes[end] !== 0 && isChunkId(bytes, end) ? end : end + (declared & 1);
  }
  return chunks;
}

function isChunkId(bytes: Uint8Array, o: number): boolean {
  if (o + 4 > bytes.length) return false;
  for (let i = o; i < o + 4; i++) {
    const c = bytes[i] as number;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function decodeWav(bytes: Uint8Array, view: DataView): DecodedPcm | null {
  let fmt: Chunk | undefined;
  let data: Chunk | undefined;
  let smpl: Chunk | undefined;
  for (const c of readChunks(bytes, view, true)) {
    if (c.id === 'fmt ') fmt ??= c;
    else if (c.id === 'data') data ??= c;
    else if (c.id === 'smpl') smpl ??= c;
  }
  if (!fmt || !data || fmt.size < 16) return null;
  const f = fmt.start;
  let format = view.getUint16(f, true);
  const numChannels = view.getUint16(f + 2, true);
  const sampleRate = view.getUint32(f + 4, true);
  const blockAlign = view.getUint16(f + 12, true);
  const bits = view.getUint16(f + 14, true);
  if (format === WAVE_FORMAT_EXTENSIBLE) {
    if (fmt.size < 40) return null;
    for (let i = 0; i < KSDATAFORMAT_SUFFIX.length; i++) {
      if (bytes[f + 26 + i] !== KSDATAFORMAT_SUFFIX[i]) return null;
    }
    format = view.getUint16(f + 24, true);
  }
  if (numChannels < 1 || sampleRate < 1 || bits < 1) return null;

  let layout: PcmLayout;
  if (format === WAVE_FORMAT_PCM) {
    if (bits > 32) return null;
    const width = containerWidth(bits, blockAlign, numChannels);
    layout = pcmLayout(width === 1 ? 'uint' : 'int', width, true, numChannels, blockAlign);
  } else if (format === WAVE_FORMAT_IEEE_FLOAT) {
    if (bits !== 32 && bits !== 64) return null;
    layout = pcmLayout('float', bits / 8, true, numChannels, blockAlign);
  } else {
    return null; // ADPCM, µ-law, MP3-in-WAV, …
  }

  const frames = Math.floor(data.size / layout.frameBytes);
  const result: DecodedPcm = { sampleRate, channels: readFrames(view, data.start, frames, layout) };
  if (smpl && smpl.size >= 36) {
    const s = smpl.start;
    const unity = view.getUint32(s + 12, true);
    if (unity <= 127) result.rootKey = unity;
    const loops = view.getUint32(s + 28, true);
    if (loops > 0 && smpl.size >= 36 + 24) {
      // Each loop: cue id, type, start, end (inclusive: "this sample will also be played"), fraction, count.
      const loop = validLoop(view.getUint32(s + 36 + 8, true), view.getUint32(s + 36 + 12, true) + 1, frames);
      if (loop) result.loop = loop;
    }
  }
  return result;
}

function decodeAiff(bytes: Uint8Array, view: DataView, aifc: boolean): DecodedPcm | null {
  let comm: Chunk | undefined;
  let ssnd: Chunk | undefined;
  let inst: Chunk | undefined;
  let mark: Chunk | undefined;
  for (const c of readChunks(bytes, view, false)) {
    if (c.id === 'COMM') comm ??= c;
    else if (c.id === 'SSND') ssnd ??= c;
    else if (c.id === 'INST') inst ??= c;
    else if (c.id === 'MARK') mark ??= c;
  }
  if (!comm || !ssnd || comm.size < 18 || ssnd.size < 8) return null;
  const c = comm.start;
  const numChannels = view.getInt16(c, false);
  const declaredFrames = view.getUint32(c + 2, false);
  const bits = view.getInt16(c + 6, false);
  const sampleRate = readExtended(view, c + 8);
  let compression = 'NONE';
  if (aifc) {
    if (comm.size < 22) return null;
    compression = readTag(bytes, c + 18);
  }
  if (numChannels < 1 || bits < 1 || !(sampleRate > 0) || !Number.isFinite(sampleRate)) return null;

  let kind: SampleKind;
  let width: number;
  let littleEndian = false;
  switch (compression) {
    case 'NONE':
    case 'twos':
      if (bits > 32) return null;
      kind = 'int'; // AIFF 8-bit is signed, unlike WAV
      width = Math.ceil(bits / 8);
      break;
    case 'sowt':
      if (bits > 32) return null;
      kind = 'int';
      width = Math.ceil(bits / 8);
      littleEndian = true;
      break;
    case 'fl32':
    case 'FL32':
      kind = 'float';
      width = 4;
      break;
    case 'fl64':
    case 'FL64':
      kind = 'float';
      width = 8;
      break;
    default:
      return null; // compressed AIFC (ima4, ulaw, alaw, …)
  }
  const layout = pcmLayout(kind, width, littleEndian, numChannels, 0);
  // SSND: offset (u32) and block size (u32), then sound data starting `offset` bytes later.
  const dataStart = ssnd.start + 8 + view.getUint32(ssnd.start, false);
  const available = Math.max(0, ssnd.start + ssnd.size - dataStart);
  const frames = Math.min(declaredFrames, Math.floor(available / layout.frameBytes));
  const result: DecodedPcm = { sampleRate, channels: readFrames(view, dataStart, frames, layout) };

  if (inst && inst.size >= 20) {
    const baseNote = view.getInt8(inst.start);
    if (baseNote >= 0 && baseNote <= 127) result.rootKey = baseNote;
    const playMode = view.getInt16(inst.start + 8, false);
    if (playMode !== 0 && mark) {
      const markers = readMarkers(bytes, view, mark);
      const begin = markers.get(view.getInt16(inst.start + 10, false));
      const end = markers.get(view.getInt16(inst.start + 12, false));
      // AIFF markers sit between frames, so the end marker is already exclusive.
      const loop = begin !== undefined && end !== undefined ? validLoop(begin, end, frames) : null;
      if (loop) result.loop = loop;
    }
  }
  return result;
}

function readMarkers(bytes: Uint8Array, view: DataView, mark: Chunk): Map<number, number> {
  const markers = new Map<number, number>();
  if (mark.size < 2) return markers;
  const count = view.getUint16(mark.start, false);
  const end = mark.start + mark.size;
  let o = mark.start + 2;
  for (let i = 0; i < count && o + 7 <= end; i++) {
    const id = view.getInt16(o, false);
    const position = view.getUint32(o + 2, false);
    const nameLength = bytes[o + 6] as number;
    markers.set(id, position);
    // id + position + pstring (count byte + text), padded to an even length.
    o += 6 + 1 + nameLength + ((1 + nameLength) & 1);
  }
  return markers;
}

function containerWidth(bits: number, blockAlign: number, channels: number): number {
  const minimum = Math.ceil(bits / 8);
  const fromBlock = blockAlign / channels;
  return Number.isInteger(fromBlock) && fromBlock >= minimum && fromBlock <= 4 ? fromBlock : minimum;
}

function pcmLayout(
  kind: SampleKind,
  width: number,
  littleEndian: boolean,
  channels: number,
  blockAlign: number,
): PcmLayout {
  return { kind, width, littleEndian, channels, frameBytes: Math.max(blockAlign, channels * width) };
}

function readFrames(view: DataView, start: number, frames: number, l: PcmLayout): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < l.channels; c++) out.push(new Float32Array(frames));
  const le = l.littleEndian;
  for (let c = 0; c < l.channels; c++) {
    const dst = out[c] as Float32Array;
    let o = start + c * l.width;
    const step = l.frameBytes;
    if (l.kind === 'float') {
      if (l.width === 4) for (let i = 0; i < frames; i++, o += step) dst[i] = view.getFloat32(o, le);
      else for (let i = 0; i < frames; i++, o += step) dst[i] = view.getFloat64(o, le);
    } else if (l.kind === 'uint') {
      for (let i = 0; i < frames; i++, o += step) dst[i] = (view.getUint8(o) - 128) / 128;
    } else if (l.width === 1) {
      for (let i = 0; i < frames; i++, o += step) dst[i] = view.getInt8(o) / 128;
    } else if (l.width === 2) {
      for (let i = 0; i < frames; i++, o += step) dst[i] = view.getInt16(o, le) / 32768;
    } else if (l.width === 3) {
      for (let i = 0; i < frames; i++, o += step) {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        const u = le ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
        dst[i] = ((u << 8) >> 8) / 8388608; // sign-extend 24 → 32 bits
      }
    } else {
      for (let i = 0; i < frames; i++, o += step) dst[i] = view.getInt32(o, le) / 2147483648;
    }
  }
  return out;
}

function validLoop(start: number, end: number, frames: number): { start: number; end: number } | null {
  const e = Math.min(end, frames);
  return start >= 0 && start < e ? { start, end: e } : null;
}

/** IEEE 754 80-bit extended (big-endian), used for AIFF sample rates. */
function readExtended(view: DataView, o: number): number {
  const signExp = view.getUint16(o, false);
  const hi = view.getUint32(o + 2, false);
  const lo = view.getUint32(o + 6, false);
  const exp = signExp & 0x7fff;
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  if (exp === 0x7fff) return NaN;
  const e = exp - 16383;
  const value = hi * Math.pow(2, e - 31) + lo * Math.pow(2, e - 63);
  return signExp & 0x8000 ? -value : value;
}

function readTag(bytes: Uint8Array, o: number): string {
  return String.fromCharCode(bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0, bytes[o + 3] ?? 0);
}

function writeTag(bytes: Uint8Array, o: number, tag: string): void {
  for (let i = 0; i < 4; i++) bytes[o + i] = tag.charCodeAt(i);
}
