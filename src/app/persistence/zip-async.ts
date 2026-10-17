import {
  projectFileParts,
  zipProjectFileParts,
  type ProjectFileParts,
  type WriteProjectFileInput,
} from '@core/io/project-file';

/**
 * Compresses a project file's entries in a Worker and resolves with the zip. Without Workers (tests in Node), or when
 * the Worker cannot start or fails, it zips here instead: an autosave is never lost to the optimisation.
 */
export function zipOffThread(parts: ProjectFileParts): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return Promise.resolve(zipProjectFileParts(parts));
  return new Promise((resolve, reject) => {
    const here = () => {
      try {
        resolve(zipProjectFileParts(parts));
      } catch (e) {
        reject(e);
      }
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL('./zip.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      here();
      return;
    }
    worker.onmessage = (e: MessageEvent<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.bytes);
      else here();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      here();
    };
    // Cloned, not transferred: the entries may be a caller's own buffers (samples), and the JSON is a memcpy.
    worker.postMessage(parts);
  });
}

/**
 * `writeProjectFile` with the compression (25-40 ms for a 1 MB project) off the main thread. The project is read
 * and serialized here, before the first await, so the file holds the document as it is now; the result is
 * byte-for-byte what `writeProjectFile` gives for the same input.
 */
export function writeProjectFileOffThread(input: WriteProjectFileInput): Promise<Uint8Array> {
  return zipOffThread(projectFileParts(input));
}
