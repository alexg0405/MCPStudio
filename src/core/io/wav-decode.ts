/**
 * A small PCM decoder for WAV and AIFF/AIFC. Chrome's decodeAudioData can't read AIFF, so this is the
 * fallback (it also reads the root key and loop points that decodeAudioData drops). Pure TypeScript, no DOM.
 */
import { WAVE_FORMAT_EXTENSIBLE, WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_PCM, type DecodedPcm } from './wav-format';

/** Bytes 2..15 of every KSDATAFORMAT_SUBTYPE_* GUID ({0000xxxx-0000-0010-8000-00aa00389b71}). */
const KSDATAFORMAT_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** RIFF and FORM files start with the container tag, a size and the form type: 12 bytes before the first chunk. */
const CONTAINER_HEADER_BYTES = 12;
/** A chunk starts with a 4-byte id and a 4-byte size. */
const CHUNK_HEADER_BYTES = 8;

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
  if (bytes.length < CONTAINER_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = readTag(bytes, 0);
  const form = readTag(bytes, 8);
  if (riff === 'RIFF' && form === 'WAVE') return decodeWav(bytes, view);
  if (riff === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return decodeAiff(bytes, view, form === 'AIFC');
  return null;
}

function readChunks(bytes: Uint8Array, view: DataView, littleEndian: boolean): Chunk[] {
  const chunks: Chunk[] = [];
  let at = CONTAINER_HEADER_BYTES;
  // The RIFF/FORM size field is often wrong in the wild (streamed or crashed writers), so walk the
  // chunks up to the end of the buffer instead.
  while (at + CHUNK_HEADER_BYTES <= bytes.length) {
    const declaredSize = view.getUint32(at + 4, littleEndian);
    const start = at + CHUNK_HEADER_BYTES;
    chunks.push({ id: readTag(bytes, at), start, size: Math.min(declaredSize, bytes.length - start) });
    const end = start + declaredSize;
    // Odd-sized chunks are followed by a zero pad byte, but some writers leave it out. A chunk id is
    // four printable characters, so a non-zero byte that starts one means the pad is missing.
    const isPadMissing = declaredSize & 1 && bytes[end] !== 0 && isChunkId(bytes, end);
    at = isPadMissing ? end : end + (declaredSize & 1);
  }
  return chunks;
}

function isChunkId(bytes: Uint8Array, at: number): boolean {
  if (at + 4 > bytes.length) return false;
  for (let i = at; i < at + 4; i++) {
    const c = bytes[i] as number;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// --- WAV ---------------------------------------------------------------------------------------

/** The `fmt ` chunk of a WAV: layout (WAVEFORMATEX, then the extensible tail) as the spec names its fields. */
interface WavFormat {
  sampleRate: number;
  layout: PcmLayout;
}

/** Byte offsets inside the `fmt ` chunk. */
const FMT = {
  formatTag: 0,
  channels: 2,
  sampleRate: 4,
  blockAlign: 12,
  bitsPerSample: 14,
  /** WAVE_FORMAT_EXTENSIBLE: valid bits (u16 at 18), channel mask (u32 at 20), then the sub-format GUID. */
  subFormatTag: 24,
  subFormatGuidSuffix: 26,
} as const;
const FMT_MIN_BYTES = 16;
const FMT_EXTENSIBLE_BYTES = 40;
const MAX_PCM_BITS = 32;

function decodeWav(bytes: Uint8Array, view: DataView): DecodedPcm | null {
  let fmt: Chunk | undefined;
  let data: Chunk | undefined;
  let smpl: Chunk | undefined;
  for (const chunk of readChunks(bytes, view, true)) {
    if (chunk.id === 'fmt ') fmt ??= chunk;
    else if (chunk.id === 'data') data ??= chunk;
    else if (chunk.id === 'smpl') smpl ??= chunk;
  }
  if (!fmt || !data || fmt.size < FMT_MIN_BYTES) return null;
  const format = readWavFormat(bytes, view, fmt);
  if (!format) return null;

  const frames = Math.floor(data.size / format.layout.frameBytes);
  const result: DecodedPcm = {
    sampleRate: format.sampleRate,
    channels: readFrames(view, data.start, frames, format.layout),
  };
  if (smpl) addSamplerInfo(view, smpl, frames, result);
  return result;
}

/** The sample rate and sample layout of a WAV `fmt ` chunk, or null for formats this decoder doesn't read. */
function readWavFormat(bytes: Uint8Array, view: DataView, fmt: Chunk): WavFormat | null {
  const at = fmt.start;
  let formatTag = view.getUint16(at + FMT.formatTag, true);
  const numChannels = view.getUint16(at + FMT.channels, true);
  const sampleRate = view.getUint32(at + FMT.sampleRate, true);
  const blockAlign = view.getUint16(at + FMT.blockAlign, true);
  const bits = view.getUint16(at + FMT.bitsPerSample, true);
  if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
    if (fmt.size < FMT_EXTENSIBLE_BYTES) return null;
    for (let i = 0; i < KSDATAFORMAT_SUFFIX.length; i++) {
      if (bytes[at + FMT.subFormatGuidSuffix + i] !== KSDATAFORMAT_SUFFIX[i]) return null;
    }
    formatTag = view.getUint16(at + FMT.subFormatTag, true);
  }
  if (numChannels < 1 || sampleRate < 1 || bits < 1) return null;

  if (formatTag === WAVE_FORMAT_PCM) {
    if (bits > MAX_PCM_BITS) return null;
    const width = containerWidth(bits, blockAlign, numChannels);
    return { sampleRate, layout: pcmLayout(width === 1 ? 'uint' : 'int', width, true, numChannels, blockAlign) };
  }
  if (formatTag === WAVE_FORMAT_IEEE_FLOAT) {
    if (bits !== 32 && bits !== 64) return null;
    return { sampleRate, layout: pcmLayout('float', bits / 8, true, numChannels, blockAlign) };
  }
  return null; // ADPCM, µ-law, MP3-in-WAV, …
}

/** Byte offsets inside the `smpl` chunk (MIDI unity note, then the loop table). */
const SMPL = { unityNote: 12, loopCount: 28, firstLoop: 36 } as const;
const SMPL_HEADER_BYTES = 36;
const SMPL_LOOP_BYTES = 24;
const LOOP_FIELD = { start: 8, end: 12 } as const;
const MAX_MIDI_KEY = 127;

/** The root key and first loop of a WAV `smpl` chunk, when it has them. */
function addSamplerInfo(view: DataView, smpl: Chunk, frames: number, result: DecodedPcm): void {
  if (smpl.size < SMPL_HEADER_BYTES) return;
  const at = smpl.start;
  const unityNote = view.getUint32(at + SMPL.unityNote, true);
  if (unityNote <= MAX_MIDI_KEY) result.rootKey = unityNote;
  const loopCount = view.getUint32(at + SMPL.loopCount, true);
  if (loopCount > 0 && smpl.size >= SMPL_HEADER_BYTES + SMPL_LOOP_BYTES) {
    // Each loop: cue id, type, start, end (inclusive: "this sample will also be played"), fraction, count.
    const loopStart = view.getUint32(at + SMPL.firstLoop + LOOP_FIELD.start, true);
    const loopEnd = view.getUint32(at + SMPL.firstLoop + LOOP_FIELD.end, true) + 1;
    const loop = validLoop(loopStart, loopEnd, frames);
    if (loop) result.loop = loop;
  }
}

// --- AIFF / AIFC -------------------------------------------------------------------------------

/** Byte offsets inside the AIFF `COMM` chunk (big endian). */
const COMM = { channels: 0, frames: 2, bitsPerSample: 6, sampleRate: 8, compressionTag: 18 } as const;
const COMM_MIN_BYTES = 18;
const COMM_AIFC_MIN_BYTES = 22;
const SSND_HEADER_BYTES = 8;
/** Byte offsets inside the AIFF `INST` chunk. */
const INST = { baseNote: 0, sustainPlayMode: 8, sustainBeginMarker: 10, sustainEndMarker: 12 } as const;
const INST_MIN_BYTES = 20;

function decodeAiff(bytes: Uint8Array, view: DataView, isAifc: boolean): DecodedPcm | null {
  let comm: Chunk | undefined;
  let ssnd: Chunk | undefined;
  let inst: Chunk | undefined;
  let mark: Chunk | undefined;
  for (const chunk of readChunks(bytes, view, false)) {
    if (chunk.id === 'COMM') comm ??= chunk;
    else if (chunk.id === 'SSND') ssnd ??= chunk;
    else if (chunk.id === 'INST') inst ??= chunk;
    else if (chunk.id === 'MARK') mark ??= chunk;
  }
  if (!comm || !ssnd || comm.size < COMM_MIN_BYTES || ssnd.size < SSND_HEADER_BYTES) return null;
  const at = comm.start;
  const numChannels = view.getInt16(at + COMM.channels, false);
  const declaredFrames = view.getUint32(at + COMM.frames, false);
  const bits = view.getInt16(at + COMM.bitsPerSample, false);
  const sampleRate = readExtended(view, at + COMM.sampleRate);
  let compression = 'NONE';
  if (isAifc) {
    if (comm.size < COMM_AIFC_MIN_BYTES) return null;
    compression = readTag(bytes, at + COMM.compressionTag);
  }
  if (numChannels < 1 || bits < 1 || !(sampleRate > 0) || !Number.isFinite(sampleRate)) return null;

  const sampleFormat = aiffSampleFormat(compression, bits);
  if (!sampleFormat) return null;
  const layout = pcmLayout(sampleFormat.kind, sampleFormat.width, sampleFormat.littleEndian, numChannels, 0);
  // SSND: offset (u32) and block size (u32), then sound data starting `offset` bytes later.
  const dataStart = ssnd.start + SSND_HEADER_BYTES + view.getUint32(ssnd.start, false);
  const available = Math.max(0, ssnd.start + ssnd.size - dataStart);
  const frames = Math.min(declaredFrames, Math.floor(available / layout.frameBytes));
  const result: DecodedPcm = { sampleRate, channels: readFrames(view, dataStart, frames, layout) };
  if (inst && inst.size >= INST_MIN_BYTES) addInstrumentInfo(bytes, view, inst, mark, frames, result);
  return result;
}

/** How an AIFF(-C) compression tag lays out its samples, or null for compressed audio (ima4, ulaw, alaw, …). */
function aiffSampleFormat(
  compression: string,
  bits: number,
): { kind: SampleKind; width: number; littleEndian: boolean } | null {
  switch (compression) {
    case 'NONE':
    case 'twos':
      if (bits > MAX_PCM_BITS) return null;
      // AIFF 8-bit is signed, unlike WAV.
      return { kind: 'int', width: Math.ceil(bits / 8), littleEndian: false };
    case 'sowt':
      if (bits > MAX_PCM_BITS) return null;
      return { kind: 'int', width: Math.ceil(bits / 8), littleEndian: true };
    case 'fl32':
    case 'FL32':
      return { kind: 'float', width: 4, littleEndian: false };
    case 'fl64':
    case 'FL64':
      return { kind: 'float', width: 8, littleEndian: false };
    default:
      return null;
  }
}

/** The root key (`INST` base note) and sustain loop (its two markers in `MARK`), when present. */
function addInstrumentInfo(
  bytes: Uint8Array,
  view: DataView,
  inst: Chunk,
  mark: Chunk | undefined,
  frames: number,
  result: DecodedPcm,
): void {
  const baseNote = view.getInt8(inst.start + INST.baseNote);
  if (baseNote >= 0 && baseNote <= MAX_MIDI_KEY) result.rootKey = baseNote;
  const playMode = view.getInt16(inst.start + INST.sustainPlayMode, false);
  if (playMode === 0 || !mark) return;
  const markers = readMarkers(bytes, view, mark);
  const begin = markers.get(view.getInt16(inst.start + INST.sustainBeginMarker, false));
  const end = markers.get(view.getInt16(inst.start + INST.sustainEndMarker, false));
  // AIFF markers sit between frames, so the end marker is already exclusive.
  const loop = begin !== undefined && end !== undefined ? validLoop(begin, end, frames) : null;
  if (loop) result.loop = loop;
}

function readMarkers(bytes: Uint8Array, view: DataView, mark: Chunk): Map<number, number> {
  const markers = new Map<number, number>();
  if (mark.size < 2) return markers;
  const count = view.getUint16(mark.start, false);
  const end = mark.start + mark.size;
  let at = mark.start + 2;
  for (let i = 0; i < count && at + 7 <= end; i++) {
    const id = view.getInt16(at, false);
    const position = view.getUint32(at + 2, false);
    const nameLength = bytes[at + 6] as number;
    markers.set(id, position);
    // id + position + pstring (count byte + text), padded to an even length.
    at += 6 + 1 + nameLength + ((1 + nameLength) & 1);
  }
  return markers;
}

// --- Samples -----------------------------------------------------------------------------------

/** Bytes per sample: the block alignment says (when it divides evenly into 1–4 bytes), else the bits round up. */
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

/** Reads `frames` frames into float channels in [-1, 1). This loop runs once per sample of the file. */
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

/** A loop inside the audio: it must start before its (clamped) end. */
function validLoop(start: number, end: number, frames: number): { start: number; end: number } | null {
  const clampedEnd = Math.min(end, frames);
  return start >= 0 && start < clampedEnd ? { start, end: clampedEnd } : null;
}

/** IEEE 754 80-bit extended (big-endian), used for AIFF sample rates. */
function readExtended(view: DataView, at: number): number {
  const signExponent = view.getUint16(at, false);
  const high = view.getUint32(at + 2, false);
  const low = view.getUint32(at + 6, false);
  const exponent = signExponent & 0x7fff;
  if (exponent === 0 && high === 0 && low === 0) return 0;
  if (exponent === 0x7fff) return NaN;
  const e = exponent - 16383;
  const value = high * Math.pow(2, e - 31) + low * Math.pow(2, e - 63);
  return signExponent & 0x8000 ? -value : value;
}

function readTag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}
