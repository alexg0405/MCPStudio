import { analyzeSample } from '@core/samples/analyze';
import { SAMPLE_ANALYSIS_VERSION } from '@core/samples/types';
import type { WorkerReply, WorkerRequest } from './protocol';
import { readForAnalysis } from './read';

// Reads and analyzes one file at a time off the main thread (see docs/architecture.md, "Sample browser").
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
};

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.kind === 'audio') {
      scope.postMessage({ id: m.id, ok: true, analysis: analyzeSample(m.channels, m.sampleRate, { path: m.path, durationSec: m.durationSec }) });
      return;
    }
    const read = await readForAnalysis(m.file);
    if (read.kind === 'audio') {
      scope.postMessage({ id: m.id, ok: true, analysis: analyzeSample(read.channels, read.sampleRate, { path: m.path, durationSec: read.durationSec }) });
    } else if (read.kind === 'long') {
      scope.postMessage({
        id: m.id,
        ok: true,
        analysis: { v: SAMPLE_ANALYSIS_VERSION, kind: 'long', durationSec: read.durationSec, category: null, confidence: 0, loudnessDb: -180, peakDb: -180, brightness: 0, vec: [] },
      });
    } else if (read.kind === 'needs-decode') {
      scope.postMessage({ id: m.id, ok: false, reason: 'needs-decode', durationSec: read.durationSec });
    } else {
      scope.postMessage({ id: m.id, ok: false, reason: 'unreadable' });
    }
  } catch (err) {
    scope.postMessage({ id: m.id, ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
