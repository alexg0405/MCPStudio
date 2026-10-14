/**
 * Audio file encoding for exports: WAV (16-bit dithered, 24-bit, 32-bit float), FLAC (16/24-bit,
 * our own encoder) and MP3 (LAME, constant bit rate). Runs in a Worker so a long song doesn't
 * freeze the app; the main thread does it where there is no Worker (Node tests).
 */
import { encodeFlac } from '@core/io/flac';
import { encodeWav } from '@core/io/wav';

export type AudioCodec = 'wav' | 'flac' | 'mp3';

export interface EncodeSpec {
  codec: AudioCodec;
  /** WAV 16/24/32 (32 = float), FLAC 16/24; MP3 ignores it. */
  bits: 16 | 24 | 32;
  /** MP3 bit rate in kbps. */
  kbps: number;
}

/** Sample rates MP3 can hold at the bit rates we offer (MPEG-1 Layer III). */
export const MP3_SAMPLE_RATES: readonly number[] = [32000, 44100, 48000];

export const CODEC_EXTENSIONS: Record<AudioCodec, string> = { wav: 'wav', flac: 'flac', mp3: 'mp3' };
export const CODEC_MIME: Record<AudioCodec, string> = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };

/** WAV and FLAC on the calling thread (the Worker's body; MP3 needs encodeAudioAsync). */
export function encodeLossless(channels: Float32Array[], sampleRate: number, spec: EncodeSpec): Uint8Array {
  if (spec.codec === 'flac')
    return encodeFlac(channels, sampleRate, { bitDepth: spec.bits === 16 ? 16 : 24, dither: spec.bits === 16, seed: 1 });
  const bitDepth = spec.bits;
  return encodeWav(channels, sampleRate, { bitDepth, dither: bitDepth === 16, seed: 1 });
}

/** Any codec on the calling thread (the LAME encoder is loaded on first use). */
export async function encodeAudioAsync(channels: Float32Array[], sampleRate: number, spec: EncodeSpec): Promise<Uint8Array> {
  if (spec.codec !== 'mp3') return encodeLossless(channels, sampleRate, spec);
  const { encodeMp3 } = await import('./mp3');
  return encodeMp3(channels, sampleRate, spec.kbps);
}

export class EncodeError extends Error {}

/** Encodes in a Worker when there is one. The channel buffers are transferred (don't reuse them). */
export function encodeOffThread(channels: Float32Array[], sampleRate: number, spec: EncodeSpec): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return encodeAudioAsync(channels, sampleRate, spec);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.bytes);
      else reject(new EncodeError(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new EncodeError(e.message || `The ${spec.codec.toUpperCase()} encoder failed.`));
    };
    worker.postMessage(
      { channels, sampleRate, spec },
      channels.map((c) => c.buffer as ArrayBuffer),
    );
  });
}
