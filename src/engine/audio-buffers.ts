/**
 * Copies derived from decoded samples that audio clips play, made without stalling the main thread
 * while music plays: reversed copies and peak overviews are built in slices of about a second of
 * audio with a yield between slices (cheaper than shipping the audio to a Worker and back), and
 * time-stretching (WSOLA) runs in a small pool of Workers. The caller caches the results
 * (SampleCache, counted in its memory budget).
 */
import { timeStretch } from '@core/audio/wsola';
import { decodePcm16Range, encodePcm16, readPcm16Info } from '@core/io/pcm16';
import type { Waveform } from './waveform';

/** Frames handled between two yields (~1.4 s at 48 kHz: well under a millisecond of copying). */
const SLICE = 1 << 16;

let yieldChannel: MessageChannel | null = null;
const yieldQueue: (() => void)[] = [];

/**
 * Lets other tasks run (the scheduler's clock, input, rendering) before continuing. A MessageChannel
 * task, not setTimeout: no 4 ms clamp, so a long job still finishes quickly when nothing else waits.
 */
export function yieldToMain(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
  }
  const ch = yieldChannel;
  return new Promise((resolve) => {
    yieldQueue.push(resolve);
    ch.port2.postMessage(0);
  });
}

/** Copies frames [from, to) of each channel out of a buffer, a slice at a time. */
export async function copyChannels(source: AudioBuffer, from = 0, to = source.length): Promise<Float32Array[]> {
  const a = Math.max(0, Math.min(source.length, Math.floor(from)));
  const b = Math.max(a, Math.min(source.length, Math.ceil(to)));
  const out: Float32Array[] = [];
  for (let c = 0; c < source.numberOfChannels; c++) {
    const dst = new Float32Array(b - a);
    const src = source.getChannelData(c);
    for (let i = a; i < b; i += SLICE * 4) {
      dst.set(src.subarray(i, Math.min(b, i + SLICE * 4)), i - a);
      if (i + SLICE * 4 < b) await yieldToMain();
    }
    out.push(dst);
  }
  return out;
}

/** An AudioBuffer holding these channels, filled a slice at a time. */
export async function bufferFrom(channels: readonly Float32Array[], sampleRate: number): Promise<AudioBuffer | null> {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return null;
  const b = new AudioBuffer({ length, numberOfChannels: channels.length, sampleRate });
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c] as Float32Array<ArrayBuffer>;
    for (let i = 0; i < length; i += SLICE * 4) {
      b.copyToChannel(ch.subarray(i, Math.min(length, i + SLICE * 4)), c, i);
      if (i + SLICE * 4 < length) await yieldToMain();
    }
  }
  return b;
}

/** An AudioBuffer from 16-bit PCM bytes (core/io/pcm16.ts), converted a slice at a time; null if they aren't valid. */
export async function bufferFromPcm16(bytes: Uint8Array): Promise<AudioBuffer | null> {
  const info = readPcm16Info(bytes);
  if (!info || info.frames === 0) return null;
  const b = new AudioBuffer({ length: info.frames, numberOfChannels: info.channels, sampleRate: info.sampleRate });
  const scratch = new Float32Array(Math.min(info.frames, SLICE * 4));
  for (let c = 0; c < info.channels; c++) {
    for (let i = 0; i < info.frames; i += scratch.length) {
      const n = Math.min(scratch.length, info.frames - i);
      decodePcm16Range(bytes, info, c, i, i + n, scratch);
      b.copyToChannel(n === scratch.length ? scratch : scratch.subarray(0, n), c, i);
      if (i + n < info.frames) await yieldToMain();
    }
  }
  return b;
}

/** The sample played backwards. */
export async function reverseBuffer(source: AudioBuffer): Promise<AudioBuffer> {
  const n = source.length;
  const r = new AudioBuffer({ length: n, numberOfChannels: source.numberOfChannels, sampleRate: source.sampleRate });
  for (let c = 0; c < source.numberOfChannels; c++) {
    const src = source.getChannelData(c);
    const dst = r.getChannelData(c);
    for (let i0 = 0; i0 < n; i0 += SLICE) {
      const i1 = Math.min(n, i0 + SLICE);
      for (let i = i0, j = n - 1 - i0; i < i1; i++, j--) dst[i] = src[j] as number;
      if (i1 < n) await yieldToMain();
    }
  }
  return r;
}

/** Peak overview ([min, max] per `bucket` frames over all channels), computed a slice at a time. */
export async function peaksOf(buffer: AudioBuffer, bucket = 256): Promise<Waveform> {
  const buckets = Math.max(1, Math.ceil(buffer.length / bucket));
  const peaks = new Float32Array(buckets * 2);
  const perSlice = Math.max(1, Math.floor(SLICE / bucket));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b0 = 0; b0 < buckets; b0 += perSlice) {
      const b1 = Math.min(buckets, b0 + perSlice);
      for (let b = b0; b < b1; b++) {
        let lo = peaks[b * 2] as number;
        let hi = peaks[b * 2 + 1] as number;
        const end = Math.min(data.length, (b + 1) * bucket);
        for (let i = b * bucket; i < end; i++) {
          const v = data[i] as number;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        peaks[b * 2] = lo;
        peaks[b * 2 + 1] = hi;
      }
      if (b1 < buckets) await yieldToMain();
    }
  }
  return { peaks, bucket, sampleRate: buffer.sampleRate, duration: buffer.duration };
}

// ---------------------------------------------------------------- time-stretch worker pool

export interface StretchJob {
  /** The channels to stretch (transferred: don't use them afterwards). */
  channels: Float32Array[];
  scale: number;
  sampleRate: number;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

type Done = { resolve(bytes: Uint8Array): void; reject(e: unknown): void };

/** Workers in the pool: enough to stretch two songs of a transition at once, never all the cores. */
export const STRETCH_WORKERS = Math.max(
  1,
  Math.min(3, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) - 2 || 1),
);

const pool: PoolWorker[] = [];
const queue: Array<{ job: StretchJob; done: Done; priority: number }> = [];
const running = new Map<number, Done>();
let seq = 0;
let workersUnavailable = false;

function spawn(): PoolWorker | null {
  try {
    const w: PoolWorker = {
      worker: new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' }),
      busy: false,
    };
    w.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; bytes?: Uint8Array; error?: string }>) => {
      const done = running.get(e.data.id);
      running.delete(e.data.id);
      w.busy = false;
      if (done) {
        if (e.data.ok && e.data.bytes) done.resolve(e.data.bytes);
        else done.reject(new Error(e.data.error ?? 'time-stretch failed'));
      }
      next();
    };
    w.worker.onerror = (e) => {
      // The job it was running fails; the worker is replaced on the next job.
      w.worker.terminate();
      pool.splice(pool.indexOf(w), 1);
      for (const [id, done] of running) {
        if ((done as Done & { w?: PoolWorker }).w === w) {
          running.delete(id);
          done.reject(new Error(e.message || 'the time-stretch worker failed'));
        }
      }
      next();
    };
    return w;
  } catch {
    workersUnavailable = true;
    return null;
  }
}

function next(): void {
  while (queue.length > 0) {
    let w = pool.find((p) => !p.busy);
    if (!w && pool.length < STRETCH_WORKERS) {
      const made = spawn();
      if (!made) break;
      pool.push(made);
      w = made;
    }
    if (!w) return;
    const item = queue.shift()!;
    const id = ++seq;
    w.busy = true;
    running.set(id, Object.assign(item.done, { w }));
    const { channels, scale, sampleRate } = item.job;
    w.worker.postMessage({ id, channels, scale, sampleRate }, channels.map((c) => c.buffer as ArrayBuffer));
  }
  // No Workers here (Node tests): run what is queued inline.
  if (workersUnavailable) {
    for (const item of queue.splice(0)) {
      const { channels, scale, sampleRate } = item.job;
      Promise.resolve()
        .then(() => encodePcm16(timeStretch(channels, scale, { sampleRate }), sampleRate))
        .then(item.done.resolve, item.done.reject);
    }
  }
}

/**
 * Time-stretches channels in a pool Worker (WSOLA) and returns the copy as 16-bit PCM bytes
 * (core/io/pcm16.ts: what is kept on disk too). Lower `priority` runs first (the engine passes how
 * soon playback reaches the clip). The channels are transferred.
 */
export function runStretch(job: StretchJob, priority = 0): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') workersUnavailable = true;
  return new Promise((resolve, reject) => {
    const item = { job, done: { resolve, reject }, priority };
    const at = queue.findIndex((q) => q.priority > priority);
    if (at < 0) queue.push(item);
    else queue.splice(at, 0, item);
    next();
  });
}

/** Stretch jobs waiting or running (diagnostics). */
export function stretchQueueLength(): number {
  return queue.length + running.size;
}
