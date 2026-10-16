/**
 * The Xing/Info frame with a LAME tag that makes an MP3 gapless. lamejs writes none, so a decoder
 * can't know that the first 576 + 529 samples it produces are encoder and decoder delay (and that the
 * last frame is padded): the decoded file starts about 25 ms late and runs 25 ms long next to the WAV.
 *
 * The frame goes first in the file. It is a valid MPEG-1 Layer III frame at the stream's bit rate,
 * sample rate and channel mode whose audio is silent (side information all zero), and in the place a
 * Xing header lives it carries "Info" (constant bit rate), the number of frames and bytes, a table of
 * contents, and the LAME extension with the encoder delay and padding. Players that know it (Chrome and
 * ffmpeg, foobar2000, iTunes, VLC) drop the delay and the padding; the others play a silent frame.
 *
 * Layout (offsets from the start of the frame; stereo, MPEG-1: the tag starts 4 + 32 bytes in, 4 + 17 mono):
 *   0   4  frame header (padding bit 0)
 *   4  32  side information (zeros)
 *  36   4  "Info"
 *  40   4  flags: 1 frames, 2 bytes, 4 table of contents, 8 quality (we write all four)
 *  44   4  number of audio frames, not counting this one
 *  48   4  number of bytes in the file, counting this frame (not an ID3v2 tag)
 *  52 100  table of contents (byte position of each percent of the stream, 0..255 of the length)
 * 152   4  quality (0..100)
 * 156   9  encoder version string ("LAME3.98 ")
 * 165   1  tag revision (high nibble) and VBR method (low nibble; 1 = CBR)
 * 166   1  low-pass filter in units of 100 Hz (0: not given)
 * 167   8  replay gain: peak (float), radio and audiophile adjustments (zeros: none)
 * 175   1  encoding flags and ATH type
 * 176   1  bit rate (the specified one for CBR; 255 above 254)
 * 177   3  encoder delay (12 bits) and encoder padding (12 bits)
 * 180   1  misc: stereo mode (bits 2-4), source sample rate (bits 6-7)
 * 181   1  MP3 gain
 * 182   2  preset and surround info
 * 184   4  music length: bytes of the file, counting this frame
 * 188   2  music CRC-16 of the audio frames that follow this one
 * 190   2  CRC-16 of the 190 bytes above
 *
 * Gapless playback: a decoder skips `delay + 529` samples from the start of what it decodes (529 is
 * its own delay) and ends the stream `padding − 529` samples before the end of the last frame. So
 * `delay + samples + padding` is the number of frames × 1152.
 *
 * References: the LAME source (`libmp3lame/VbrTag.c`), the Xing/LAME tag description at gabriel.mp3-tech.org
 * ("MP3 Info Tag revision 1 specifications"), and ffmpeg's `libavformat/mp3dec.c` for what decoders read.
 */

/** The delay LAME's encoder adds before the first input sample (`ENCDELAY`; lamejs is LAME 3.98's port). */
export const LAME_ENCODER_DELAY = 576;
/** Samples per MPEG-1 Layer III frame. */
export const MP3_FRAME_SAMPLES = 1152;
/** Bit rates MPEG-1 Layer III has (kbps), by header index 1..14. */
export const MP3_BITRATES: readonly number[] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [44100, 48000, 32000];
const LAME_TAG_BYTES = 36;
const TOC_BYTES = 100;

/** The Layer III bit rate nearest `kbps` (what LAME uses when it is asked for one that doesn't exist). */
export function nearestMp3Bitrate(kbps: number): number {
  let best = MP3_BITRATES[0] as number;
  for (const b of MP3_BITRATES) if (Math.abs(b - kbps) < Math.abs(best - kbps)) best = b;
  return best;
}

/** Bytes in an MPEG-1 Layer III frame without the padding slot. */
export function mp3FrameBytes(kbps: number, sampleRate: number, padding = 0): number {
  return Math.floor((144000 * kbps) / sampleRate) + padding;
}

/** CRC-16 as LAME writes it: the reflected polynomial 0x8005 (0xA001), start 0. */
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc16(bytes: Uint8Array, crc = 0): number {
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number);
  return crc & 0xffff;
}

/** The 4-byte header of a silent frame: MPEG-1, Layer III, no CRC, no padding. `mode` 3 = mono, 1 = joint stereo. */
function frameHeader(kbps: number, sampleRate: number, mono: boolean, from?: Uint8Array | null): Uint8Array {
  const h = new Uint8Array(4);
  if (from && from.length >= 4) {
    h.set(from.subarray(0, 4));
    h[2] = (h[2] as number) & ~0x02; // The padding slot would make the frame longer than the room kept for it.
    return h;
  }
  const br = MP3_BITRATES.indexOf(kbps) + 1;
  const sr = SAMPLE_RATES.indexOf(sampleRate);
  if (br < 1 || sr < 0) throw new RangeError(`No MP3 frame at ${kbps} kbps and ${sampleRate} Hz.`);
  h[0] = 0xff;
  h[1] = 0xfb;
  h[2] = (br << 4) | (sr << 2);
  h[3] = mono ? 0xc0 : 0x40;
  return h;
}

export interface InfoFrameOptions {
  kbps: number;
  sampleRate: number;
  channels: number;
  /** Audio frames in the stream (not counting this frame). */
  frames: number;
  /** Bytes of the audio frames (this frame is added). */
  audioBytes: number;
  /** Samples of audio that went in (what the file should decode to). */
  samples: number;
  /** CRC-16 of the audio frames' bytes. */
  musicCrc: number;
  /** The first audio frame's header, to copy the mode from (else joint stereo or mono as the channels say). */
  firstHeader?: Uint8Array | null;
}

/** Bytes of the Info frame for a stream, or 0 when its frame is too small for the LAME tag. */
export function infoFrameBytes(kbps: number, sampleRate: number, channels: number): number {
  const size = mp3FrameBytes(kbps, sampleRate);
  return size >= 4 + sideInfoBytes(channels === 1) + 4 + 4 + 4 + 4 + 4 + TOC_BYTES + 4 + LAME_TAG_BYTES ? size : 0;
}

const sideInfoBytes = (mono: boolean) => (mono ? 17 : 32);

/** The delay/padding that make `samples` of audio in `frames` frames decode gapless. */
export function gaplessPadding(frames: number, samples: number): number {
  return Math.max(0, frames * MP3_FRAME_SAMPLES - samples - LAME_ENCODER_DELAY);
}

/**
 * The Info frame. With `frames: 0` it is a valid frame for the start of a file whose length isn't known
 * yet (written first, then replaced by the complete one, which has exactly the same size).
 */
export function buildInfoFrame(o: InfoFrameOptions): Uint8Array {
  const size = infoFrameBytes(o.kbps, o.sampleRate, o.channels);
  if (size === 0) throw new RangeError('The MP3 frame is too small for a gapless header.');
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const header = frameHeader(o.kbps, o.sampleRate, o.channels === 1, o.firstHeader);
  out.set(header, 0);
  const mono = header[3]! >> 6 === 3;
  const x = 4 + sideInfoBytes(mono);
  out.set([0x49, 0x6e, 0x66, 0x6f], x); // "Info"
  v.setUint32(x + 4, 0x0f);
  v.setUint32(x + 8, o.frames);
  const total = size + o.audioBytes;
  v.setUint32(x + 12, total);
  for (let i = 0; i < TOC_BYTES; i++) out[x + 16 + i] = Math.min(255, Math.floor((i * 256) / TOC_BYTES));
  v.setUint32(x + 16 + TOC_BYTES, 0);
  const t = x + 20 + TOC_BYTES;
  out.set([0x4c, 0x41, 0x4d, 0x45, 0x33, 0x2e, 0x39, 0x38, 0x20], t); // "LAME3.98 "
  out[t + 9] = 0x01; // revision 0, CBR
  out[t + 20] = Math.min(255, o.kbps);
  const delay = o.frames > 0 ? LAME_ENCODER_DELAY : 0;
  const padding = o.frames > 0 ? Math.min(4095, gaplessPadding(o.frames, o.samples)) : 0;
  out[t + 21] = delay >> 4;
  out[t + 22] = ((delay & 0x0f) << 4) | (padding >> 8);
  out[t + 23] = padding & 0xff;
  const stereoMode = mono ? 3 : ((header[3] as number) >> 6) & 3;
  const rateClass = o.sampleRate === 44100 ? 1 : o.sampleRate === 48000 ? 2 : 0;
  out[t + 24] = (stereoMode << 2) | (rateClass << 6);
  v.setUint32(t + 28, total);
  v.setUint16(t + 32, o.musicCrc);
  v.setUint16(t + 34, crc16(out.subarray(0, t + 34)));
  return out;
}

export interface InfoFrame {
  kbps: number;
  sampleRate: number;
  channels: number;
  /** "Info" for constant bit rate, "Xing" for variable. */
  tag: string;
  frames: number;
  bytes: number;
  toc: Uint8Array | null;
  /** The LAME extension, when there is one. */
  lame: { version: string; delay: number; padding: number; musicBytes: number; musicCrc: number; tagCrcOk: boolean } | null;
  /** Bytes of the frame itself. */
  frameBytes: number;
}

/** Reads the Info/Xing frame at the start of `b` (after ID3v2 tags, if any are skipped by the caller); null when there is none. */
export function parseInfoFrame(b: Uint8Array): InfoFrame | null {
  if (b.length < 8 || b[0] !== 0xff || ((b[1] as number) & 0xe0) !== 0xe0) return null;
  const version = ((b[1] as number) >> 3) & 3;
  const layer = ((b[1] as number) >> 1) & 3;
  if (version !== 3 || layer !== 1) return null; // MPEG-1 Layer III only
  const br = MP3_BITRATES[((b[2] as number) >> 4) - 1];
  const rate = SAMPLE_RATES[((b[2] as number) >> 2) & 3];
  if (br === undefined || rate === undefined) return null;
  const channels = (b[3] as number) >> 6 === 3 ? 1 : 2;
  const x = 4 + sideInfoBytes(channels === 1);
  const tag = String.fromCharCode(...b.subarray(x, x + 4));
  if ((tag !== 'Info' && tag !== 'Xing') || b.length < x + 8) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = v.getUint32(x + 4);
  let p = x + 8;
  let frames = 0;
  let bytes = 0;
  let toc: Uint8Array | null = null;
  if (flags & 1) {
    frames = v.getUint32(p);
    p += 4;
  }
  if (flags & 2) {
    bytes = v.getUint32(p);
    p += 4;
  }
  if (flags & 4) {
    toc = b.slice(p, p + TOC_BYTES);
    p += TOC_BYTES;
  }
  if (flags & 8) p += 4;
  let lame: InfoFrame['lame'] = null;
  const ver = String.fromCharCode(...b.subarray(p, p + 9));
  if (/^(LAME|Lavc|Lavf)/.test(ver) && p + LAME_TAG_BYTES <= b.length) {
    lame = {
      version: ver,
      delay: ((b[p + 21] as number) << 4) | ((b[p + 22] as number) >> 4),
      padding: (((b[p + 22] as number) & 0x0f) << 8) | (b[p + 23] as number),
      musicBytes: v.getUint32(p + 28),
      musicCrc: v.getUint16(p + 32),
      tagCrcOk: v.getUint16(p + 34) === crc16(b.subarray(0, p + 34)),
    };
  }
  return { kbps: br, sampleRate: rate, channels, tag, frames, bytes, toc, lame, frameBytes: mp3FrameBytes(br, rate) };
}

/**
 * Counts what LAME writes (frames, bytes, a CRC of them) as it comes in pieces that may split a frame
 * anywhere. CBR Layer III frames only: that is all the encoder makes.
 */
export class Mp3StreamCounter {
  frames = 0;
  bytes = 0;
  crc = 0;
  /** The first frame's header (null before there is one). */
  firstHeader: Uint8Array | null = null;
  private skip = 0;
  private readonly head: number[] = [];

  constructor(private readonly sampleRate: number) {}

  add(b: Uint8Array): void {
    this.bytes += b.length;
    this.crc = crc16(b, this.crc);
    let i = 0;
    while (i < b.length) {
      if (this.skip > 0) {
        const take = Math.min(this.skip, b.length - i);
        i += take;
        this.skip -= take;
        continue;
      }
      this.head.push(b[i++] as number);
      if (this.head.length < 4) continue;
      const h = this.head;
      const br = MP3_BITRATES[(h[2]! >> 4) - 1];
      const ok = h[0] === 0xff && (h[1]! & 0xfe) === 0xfa && br !== undefined && ((h[2]! >> 2) & 3) < 3;
      if (!ok) {
        h.shift(); // Not a frame: look one byte further on.
        continue;
      }
      this.frames++;
      this.firstHeader ??= Uint8Array.from(h);
      this.skip = mp3FrameBytes(br, this.sampleRate, (h[2]! >> 1) & 1) - 4;
      h.length = 0;
    }
  }
}
