import { zipProjectFileParts, type ProjectFileParts } from '@core/io/project-file';

// Compresses the entries of a project file off the main thread (see zip-async.ts). One message in, the zip back.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ProjectFileParts>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  try {
    const bytes = zipProjectFileParts(e.data);
    scope.postMessage({ ok: true, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
