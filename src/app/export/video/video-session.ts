/**
 * The main-thread end of the video Worker: sends it the audio a piece at a time, waits for each piece to be
 * drawn and encoded (so memory stays at a few seconds), and writes the bytes the Worker produces into a
 * sink as they arrive (appends in order, and the patches to the header at the end).
 */
import type { ByteSink } from '@platform/sinks';
import type { VideoReply, VideoRequest, VideoWorkerConfig } from './protocol';

export class VideoEncodeError extends Error {}

export interface VideoSession {
  /** Sends the next piece of stereo audio (the arrays are transferred); resolves when its pictures are encoded and written. */
  push(channels: Float32Array[]): Promise<void>;
  /** Draws the rest, finishes the file and writes it all out. */
  finish(): Promise<{ frames: number; seconds: number; bytes: number }>;
  /** Stops everything (a cancelled or failed export). */
  close(): void;
  /** Pictures made so far. */
  readonly frames: number;
}

type Waiter = { resolve(r: VideoReply): void; reject(e: unknown): void };

export async function openVideoSession(
  config: VideoWorkerConfig,
  sink: ByteSink,
  image: ImageBitmap | null,
): Promise<VideoSession> {
  const worker = new Worker(new URL('./video.worker.ts', import.meta.url), { type: 'module' });
  let waiting: Waiter | null = null;
  let failed: VideoEncodeError | null = null;
  let frames = 0;
  // Writes happen in the order the Worker made them; a failed write fails the export.
  let writes: Promise<void> = Promise.resolve();
  const queueWrite = (job: () => Promise<void>) => {
    writes = writes.then(job).catch((e: unknown) => {
      failed ??= new VideoEncodeError(e instanceof Error ? e.message : String(e));
    });
  };
  const fail = (e: VideoEncodeError) => {
    failed ??= e;
    waiting?.reject(failed);
    waiting = null;
  };
  worker.onmessage = (e: MessageEvent<VideoReply>) => {
    const m = e.data;
    if (m.t === 'write') queueWrite(() => sink.write(m.bytes));
    else if (m.t === 'patch') queueWrite(() => sink.writeAt(m.at, m.bytes));
    else if (m.t === 'error') fail(new VideoEncodeError(m.error));
    else {
      if (m.t === 'ack') frames = m.frames;
      const w = waiting;
      waiting = null;
      w?.resolve(m);
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    fail(new VideoEncodeError(e.message || 'The video encoder stopped unexpectedly.'));
  };
  const ask = (msg: VideoRequest, transfer: Transferable[] = []) =>
    new Promise<VideoReply>((resolve, reject) => {
      if (failed) return reject(failed);
      waiting = { resolve, reject };
      worker.postMessage(msg, transfer);
    });
  try {
    await ask({ t: 'open', config, image }, image ? [image] : []);
  } catch (e) {
    worker.terminate();
    throw e;
  }
  return {
    get frames() {
      return frames;
    },
    async push(channels) {
      await ask(
        { t: 'audio', channels },
        channels.map((c) => c.buffer as ArrayBuffer),
      );
      // Don't run ahead of the disk.
      await writes;
      if (failed) throw failed;
    },
    async finish() {
      const r = await ask({ t: 'finish' });
      await writes;
      if (failed) throw failed;
      worker.terminate();
      return r.t === 'done'
        ? { frames: r.frames, seconds: r.seconds, bytes: r.bytes }
        : { frames, seconds: 0, bytes: 0 };
    },
    close() {
      failed ??= new VideoEncodeError('The export was cancelled.');
      waiting?.reject(failed);
      waiting = null;
      worker.terminate();
    },
  };
}
