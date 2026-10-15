import { runAnalysis, type AnalysisJob } from './analysis-run';

// Analyzes one song at a time off the main thread: the decoded channels are transferred in, progress
// and the result come back. Cancelling terminates the Worker.
type Request = AnalysisJob & { id: number };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (e) => {
  const { id, ...job } = e.data;
  try {
    let last = -1;
    const analysis = runAnalysis(job, {
      onProgress: (fraction) => {
        // A message per percent at most.
        const pct = Math.floor(fraction * 100);
        if (pct === last) return;
        last = pct;
        scope.postMessage({ id, type: 'progress', fraction });
      },
    });
    scope.postMessage({ id, type: 'done', analysis });
  } catch (err) {
    scope.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
