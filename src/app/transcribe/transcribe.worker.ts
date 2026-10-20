import { runTranscribeJob, type TranscribeJob, type TranscribeReply } from './job';

// Listening to a recording for "Convert to MIDI", off the main thread (a drum loop or a chord read of a long clip takes a
// moment). The audio is transferred in; the result comes back as plain data.
type Request = TranscribeJob & { id: number };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (e) => {
  const { id, ...job } = e.data;
  try {
    scope.postMessage({ id, ok: true, ...runTranscribeJob(job) } satisfies TranscribeReply);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies TranscribeReply);
  }
};
