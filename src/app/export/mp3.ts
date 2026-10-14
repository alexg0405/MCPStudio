/**
 * MP3 encoding with LAME (the `@breezystack/lamejs` port): 16-bit dithered input, constant bit rate.
 * Imported only by the encoder Worker (and the main-thread fallback), so the app bundle stays small.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { quantizePcm } from '@core/io/wav';
import { MP3_SAMPLE_RATES } from './encode';

const CHUNK = 1152 * 16;

/** Encodes one or two channels (more are dropped) as a constant-bit-rate MP3. */
export function encodeMp3(channels: Float32Array[], sampleRate: number, kbps: number): Uint8Array {
  if (!MP3_SAMPLE_RATES.includes(sampleRate)) throw new RangeError(`MP3 can't hold ${sampleRate} Hz audio: use 44.1 or 48 kHz.`);
  const used = channels.slice(0, 2);
  if (used.length === 0) throw new RangeError('Nothing to encode.');
  const pcm = quantizePcm(used, 16, { dither: true, seed: 1 });
  const encoder = new Mp3Encoder(pcm.length, sampleRate, kbps);
  const parts: Uint8Array[] = [];
  const keep = (b: Uint8Array | Int8Array) => {
    if (b.length > 0) parts.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice());
  };
  const frames = pcm[0]?.length ?? 0;
  for (let i = 0; i < frames; i += CHUNK) {
    const left = new Int16Array((pcm[0] as Int32Array).subarray(i, i + CHUNK));
    const right = pcm[1] ? new Int16Array(pcm[1].subarray(i, i + CHUNK)) : undefined;
    keep(encoder.encodeBuffer(left, right));
  }
  keep(encoder.flush());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
