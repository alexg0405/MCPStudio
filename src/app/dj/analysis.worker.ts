import type { StreamRequest, WorkerReply } from './analysis-messages';
import { runAnalysis, type AnalysisJob } from './analysis-run';
import { StreamingAnalysis } from './analysis-stream';

// Analyzes one song at a time off the main thread. A whole decoded song: the channels are transferred in, progress and the
// result come back. A song read in pieces (`stream-*` messages): the main thread sends the audio chunk by chunk, each chunk
// is acknowledged when it has been worked on and forgotten, and the result comes back after `stream-end`. Cancelling
// terminates the Worker.
type Request = (AnalysisJob & { id: number; kind?: undefined }) | StreamRequest;

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: WorkerReply): void;
};

let stream: { id: number; run: StreamingAnalysis } | null = null;

/** A message per percent at most. */
function progressTo(id: number): (fraction: number) => void {
  let last = -1;
  return (fraction) => {
    const pct = Math.floor(fraction * 100);
    if (pct === last) return;
    last = pct;
    scope.postMessage({ id, type: 'progress', fraction });
  };
}

function handleStream(m: StreamRequest): void {
  try {
    if (m.kind === 'stream-start') {
      stream = { id: m.id, run: new StreamingAnalysis(m.info) };
      return;
    }
    if (!stream || stream.id !== m.id) throw new Error('The analysis was not started.');
    switch (m.kind) {
      case 'stream-region':
        stream.run.startScanRegion();
        break;
      case 'stream-scan':
        stream.run.scanChunk(m.l, m.r);
        scope.postMessage({ id: m.id, type: 'ack' });
        break;
      case 'stream-chunk':
        stream.run.push(m.l, m.r);
        scope.postMessage({ id: m.id, type: 'ack' });
        break;
      case 'stream-end': {
        const { run } = stream;
        stream = null;
        scope.postMessage({ id: m.id, type: 'done', analysis: run.finish({ onProgress: progressTo(m.id) }) });
        break;
      }
    }
  } catch (err) {
    stream = null;
    scope.postMessage({ id: m.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (e) => {
  const data = e.data;
  if (data.kind !== undefined) return handleStream(data);
  const { id, ...job } = data;
  try {
    const analysis = runAnalysis(job, { onProgress: progressTo(id) });
    scope.postMessage({ id, type: 'done', analysis });
  } catch (err) {
    scope.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
