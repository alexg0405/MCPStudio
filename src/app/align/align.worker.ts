import { runAlignJob, type AlignJob } from './run';

// Vocal alignment off the main thread (one Worker per job): the audio is transferred in, the aligned audio comes back
// transferred. The same function runs on the calling thread where there is no Worker (Node tests).
type Request = AlignJob & { id: number };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const job = e.data;
  try {
    const result = runAlignJob(job, (fraction) => scope.postMessage({ id: job.id, progress: fraction }));
    scope.postMessage({ id: job.id, ok: true, result }, result.channels.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
