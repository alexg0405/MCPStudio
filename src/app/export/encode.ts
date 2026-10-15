/**
 * Audio file encoding for exports: WAV (16-bit dithered, 24-bit, 32-bit float), FLAC (16/24-bit,
 * our own encoder) and MP3 (LAME, constant bit rate). Runs in a Worker so a long song doesn't
 * freeze the app; the main thread does it where there is no Worker (Node tests). Long exports
 * stream: the audio goes in a piece at a time and the file comes out a piece at a time
 * (`openEncodeStream`), so a 90-minute mix is never held whole.
 */
import { FlacStreamEncoder } from '@core/io/flac';
import { WavStreamEncoder } from '@core/io/wav';

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

/** An encoder fed a piece at a time on the calling thread. */
export interface PieceEncoder {
  /** The bytes that start the file (a header without the length yet; empty for MP3). */
  header(): Uint8Array;
  push(channels: readonly Float32Array[]): Uint8Array;
  /** The last bytes. */
  finish(): Uint8Array;
  /** After finish: the complete header to write over the start of the file (null: nothing to patch). */
  finalHeader(): Uint8Array | null;
}

/** Any codec (the LAME encoder is loaded on first use). */
export async function createPieceEncoder(spec: EncodeSpec, sampleRate: number, channels: number): Promise<PieceEncoder> {
  if (spec.codec === 'flac') {
    const enc = new FlacStreamEncoder(channels, sampleRate, {
      bitDepth: spec.bits === 16 ? 16 : 24,
      dither: spec.bits === 16,
      seed: 1,
    });
    return { header: () => enc.header(), push: (c) => enc.push(c), finish: () => enc.finish(), finalHeader: () => enc.header() };
  }
  if (spec.codec === 'wav') {
    const bitDepth = spec.bits;
    const enc = new WavStreamEncoder(channels, sampleRate, { bitDepth, dither: bitDepth === 16, seed: 1 });
    return { header: () => enc.header(0), push: (c) => enc.push(c), finish: () => enc.trailer(), finalHeader: () => enc.header() };
  }
  const { Mp3StreamEncoder } = await import('./mp3');
  const enc = new Mp3StreamEncoder(channels, sampleRate, spec.kbps);
  return { header: () => new Uint8Array(0), push: (c) => enc.push(c), finish: () => enc.finish(), finalHeader: () => null };
}

/** WAV and FLAC on the calling thread (the Worker's body; MP3 needs encodeAudioAsync). */
export function encodeLossless(channels: Float32Array[], sampleRate: number, spec: EncodeSpec): Uint8Array {
  if (spec.codec === 'flac') {
    const enc = new FlacStreamEncoder(channels.length, sampleRate, { bitDepth: spec.bits === 16 ? 16 : 24, dither: spec.bits === 16, seed: 1 });
    return assemble(enc.header(), [enc.push(channels)], enc.finish(), enc.header());
  }
  const enc = new WavStreamEncoder(channels.length, sampleRate, { bitDepth: spec.bits, dither: spec.bits === 16, seed: 1 });
  return assemble(enc.header(0), [enc.push(channels)], enc.trailer(), enc.header());
}

function assemble(head: Uint8Array, body: Uint8Array[], tail: Uint8Array, finalHeader: Uint8Array | null): Uint8Array {
  const parts = [head, ...body, tail];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  if (finalHeader) out.set(finalHeader, 0);
  return out;
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

/** A file encoder fed a piece at a time (off the main thread when there are Workers). */
export interface EncodeStream {
  /** The bytes that start the file. */
  readonly header: Uint8Array;
  /** Encodes the next frames (the channel buffers are transferred: don't reuse them). Calls run in order. */
  push(channels: Float32Array[]): Promise<Uint8Array>;
  /** The last bytes, and the complete header to write over the start of the file (null: none). */
  finish(): Promise<{ tail: Uint8Array; header: Uint8Array | null }>;
  /** Stops the encoder (cancelled export). */
  close(): void;
}

type StreamReply =
  | { t: 'header'; bytes: Uint8Array }
  | { t: 'bytes'; bytes: Uint8Array }
  | { t: 'done'; tail: Uint8Array; header: Uint8Array | null }
  | { t: 'error'; error: string };

export async function openEncodeStream(spec: EncodeSpec, sampleRate: number, channels: number): Promise<EncodeStream> {
  if (typeof Worker === 'undefined') {
    const enc = await createPieceEncoder(spec, sampleRate, channels);
    return {
      header: enc.header(),
      push: async (c) => enc.push(c),
      finish: async () => ({ tail: enc.finish(), header: enc.finalHeader() }),
      close: () => {},
    };
  }
  const worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
  // Replies come in the order of the requests.
  const waiting: Array<{ resolve(r: StreamReply): void; reject(e: unknown): void }> = [];
  let failed: EncodeError | null = null;
  worker.onmessage = (e: MessageEvent<StreamReply>) => {
    const w = waiting.shift();
    if (!w) return;
    if (e.data.t === 'error') w.reject(new EncodeError(e.data.error));
    else w.resolve(e.data);
  };
  worker.onerror = (e) => {
    failed = new EncodeError(e.message || `The ${spec.codec.toUpperCase()} encoder failed.`);
    for (const w of waiting.splice(0)) w.reject(failed);
    worker.terminate();
  };
  const ask = (msg: unknown, transfer: Transferable[] = []) =>
    new Promise<StreamReply>((resolve, reject) => {
      if (failed) {
        reject(failed);
        return;
      }
      waiting.push({ resolve, reject });
      worker.postMessage(msg, transfer);
    });
  const opened = await ask({ t: 'open', spec, sampleRate, channels });
  return {
    header: opened.t === 'header' ? opened.bytes : new Uint8Array(0),
    async push(c) {
      const r = await ask({ t: 'push', channels: c }, c.map((x) => x.buffer as ArrayBuffer));
      return r.t === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    async finish() {
      const r = await ask({ t: 'finish' });
      worker.terminate();
      return r.t === 'done' ? { tail: r.tail, header: r.header } : { tail: new Uint8Array(0), header: null };
    },
    close() {
      failed ??= new EncodeError('The export was cancelled.');
      for (const w of waiting.splice(0)) w.reject(failed);
      worker.terminate();
    },
  };
}
