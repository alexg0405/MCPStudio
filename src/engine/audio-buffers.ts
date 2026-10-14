/**
 * Derived copies of decoded samples that audio clips play: reversed (made on demand, instantly) and
 * time-stretched (WSOLA in a Worker, cached per sample, direction and scale). AudioBuffers aren't
 * tied to a context, so the caches are shared by every engine (reboots, offline renders) and go
 * away with their source buffer.
 */
import { timeStretch } from '@core/audio/wsola';

const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>();

/** The sample played backwards. */
export function reversedBuffer(source: AudioBuffer): AudioBuffer {
  let r = reversedCache.get(source);
  if (!r) {
    r = new AudioBuffer({ length: source.length, numberOfChannels: source.numberOfChannels, sampleRate: source.sampleRate });
    for (let c = 0; c < source.numberOfChannels; c++) {
      const src = source.getChannelData(c);
      const dst = r.getChannelData(c);
      for (let i = 0, j = src.length - 1; j >= 0; i++, j--) dst[i] = src[j] as number;
    }
    reversedCache.set(source, r);
  }
  return r;
}

interface StretchEntry {
  buffer: AudioBuffer | null;
  promise: Promise<AudioBuffer | null>;
}

const stretchCache = new WeakMap<AudioBuffer, Map<number, StretchEntry>>();

/** A finished stretched copy (`scale` × as long, same pitch), or null when it isn't ready. */
export function stretchedBuffer(source: AudioBuffer, scale: number): AudioBuffer | null {
  if (scale === 1) return source;
  return stretchCache.get(source)?.get(scale)?.buffer ?? null;
}

/** Whether a stretch of this buffer is being computed right now. */
export function isStretching(source: AudioBuffer, scale: number): boolean {
  const e = stretchCache.get(source)?.get(scale);
  return !!e && !e.buffer;
}

/** Starts (or joins) the stretch of a buffer; resolves with the copy (null if it failed). */
export function requestStretch(source: AudioBuffer, scale: number): Promise<AudioBuffer | null> {
  if (scale === 1) return Promise.resolve(source);
  let byScale = stretchCache.get(source);
  if (!byScale) {
    byScale = new Map();
    stretchCache.set(source, byScale);
  }
  const hit = byScale.get(scale);
  if (hit) return hit.promise;
  const channels = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c).slice());
  const entry: StretchEntry = { buffer: null, promise: Promise.resolve(null) };
  entry.promise = runStretch(channels, scale, source.sampleRate).then(
    (out) => {
      const length = out[0]?.length ?? 0;
      if (length === 0) return null;
      const b = new AudioBuffer({ length, numberOfChannels: out.length, sampleRate: source.sampleRate });
      out.forEach((ch, i) => b.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
      entry.buffer = b;
      return b;
    },
    (err: unknown) => {
      console.warn('[agstudio] time-stretch failed', err);
      byScale.delete(scale);
      return null;
    },
  );
  byScale.set(scale, entry);
  return entry.promise;
}

let worker: Worker | null = null;
let seq = 0;
const jobs = new Map<number, { resolve(c: Float32Array[]): void; reject(e: unknown): void }>();

function runStretch(channels: Float32Array[], scale: number, sampleRate: number): Promise<Float32Array[]> {
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => timeStretch(channels, scale, { sampleRate }));
  if (!worker) {
    try {
      worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return Promise.resolve().then(() => timeStretch(channels, scale, { sampleRate }));
    }
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; channels?: Float32Array[]; error?: string }>) => {
      const job = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (!job) return;
      if (e.data.ok && e.data.channels) job.resolve(e.data.channels);
      else job.reject(new Error(e.data.error ?? 'time-stretch failed'));
    };
    worker.onerror = (e) => {
      for (const job of jobs.values()) job.reject(new Error(e.message || 'the time-stretch worker failed'));
      jobs.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++seq;
  const w = worker;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    w.postMessage(
      { id, channels, scale, sampleRate },
      channels.map((c) => c.buffer as ArrayBuffer),
    );
  });
}
