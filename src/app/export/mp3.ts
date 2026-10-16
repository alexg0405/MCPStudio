/**
 * MP3 encoding with LAME (the `@breezystack/lamejs` port): 16-bit dithered input, constant bit rate.
 * Imported only by the encoder Worker (and the main-thread fallback), so the app bundle stays small.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { buildInfoFrame, infoFrameBytes, Mp3StreamCounter, nearestMp3Bitrate } from '@core/io/mp3-gapless';
import { PcmQuantizer } from '@core/io/wav';
import { MP3_SAMPLE_RATES } from './encode';

const CHUNK = 1152 * 16;

/**
 * MP3 a piece at a time (long exports): push audio as it comes, then finish. LAME buffers frames
 * itself, so the bytes don't depend on how the audio is split.
 *
 * The file starts with a Xing/Info frame carrying LAME's encoder delay and padding, so decoders
 * line the audio up with the WAV (`core/io/mp3-gapless.ts`). `header()` is that frame with the counts
 * still zero (a valid file as it stands); after `finish()`, `finalHeader()` is the same frame, same
 * size, with the real counts, to write over the start.
 */
export class Mp3StreamEncoder {
  private readonly encoder: Mp3Encoder;
  private readonly quantizer = new PcmQuantizer(16, { dither: true, seed: 1 });
  private readonly channels: number;
  private readonly counter: Mp3StreamCounter;
  private readonly kbps: number;
  private readonly rate: number;
  private samples = 0;

  constructor(channels: number, sampleRate: number, kbps: number) {
    if (!MP3_SAMPLE_RATES.includes(sampleRate)) throw new RangeError(`MP3 can't hold ${sampleRate} Hz audio: use 44.1 or 48 kHz.`);
    if (channels < 1) throw new RangeError('Nothing to encode.');
    // One or two channels (more are dropped).
    this.channels = Math.min(2, channels);
    this.kbps = nearestMp3Bitrate(kbps);
    this.rate = sampleRate;
    this.counter = new Mp3StreamCounter(sampleRate);
    this.encoder = new Mp3Encoder(this.channels, sampleRate, this.kbps);
  }

  /** The Info frame for the start of the file (counts still zero), or empty where the frame is too small for one. */
  header(): Uint8Array {
    if (infoFrameBytes(this.kbps, this.rate, this.channels) === 0) return new Uint8Array(0);
    return buildInfoFrame({ kbps: this.kbps, sampleRate: this.rate, channels: this.channels, frames: 0, audioBytes: 0, samples: 0, musicCrc: 0 });
  }

  /** After `finish()`: the complete Info frame, to write over the one `header()` made (null: there is none). */
  finalHeader(): Uint8Array | null {
    if (infoFrameBytes(this.kbps, this.rate, this.channels) === 0) return null;
    return buildInfoFrame({
      kbps: this.kbps,
      sampleRate: this.rate,
      channels: this.channels,
      frames: this.counter.frames,
      audioBytes: this.counter.bytes,
      samples: this.samples,
      musicCrc: this.counter.crc,
      firstHeader: this.counter.firstHeader,
    });
  }

  push(channels: readonly Float32Array[]): Uint8Array {
    const pcm = this.quantizer.quantize(channels.slice(0, this.channels));
    const parts: Uint8Array[] = [];
    const frames = pcm[0]?.length ?? 0;
    this.samples += frames;
    for (let i = 0; i < frames; i += CHUNK) {
      const left = new Int16Array((pcm[0] as Int32Array).subarray(i, i + CHUNK));
      const right = pcm[1] ? new Int16Array(pcm[1].subarray(i, i + CHUNK)) : undefined;
      keep(parts, this.encoder.encodeBuffer(left, right));
    }
    const out = join(parts);
    this.counter.add(out);
    return out;
  }

  finish(): Uint8Array {
    const parts: Uint8Array[] = [];
    keep(parts, this.encoder.flush());
    const out = join(parts);
    this.counter.add(out);
    return out;
  }
}

function keep(parts: Uint8Array[], b: Uint8Array | Int8Array): void {
  if (b.length > 0) parts.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice());
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encodes one or two channels (more are dropped) as a gapless constant-bit-rate MP3. */
export function encodeMp3(channels: Float32Array[], sampleRate: number, kbps: number): Uint8Array {
  const enc = new Mp3StreamEncoder(channels.length, sampleRate, kbps);
  const head = enc.header();
  const out = join([head, enc.push(channels), enc.finish()]);
  const fin = enc.finalHeader();
  if (fin) out.set(fin, 0);
  return out;
}
