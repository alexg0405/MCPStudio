import { isSharedMemory, sha256Hex } from '@core/io/hash';
import { readProjectFile, writeProjectFile, type EmbeddedSample } from '@core/io/project-file';
import { decodePcm, encodeWav } from '@core/io/wav';
import type { Project, SampleRef } from '@core/model/types';
import type { SampleBytesProvider } from '@engine/api';
import type { BlobStore } from '@platform/opfs';
import { defaultSampleStore } from './blob-store';

/**
 * Save/open glue between the project file format (core) and the sample blob store (OPFS). Embedded
 * samples live in the store while a project is open; a project file carries copies of them.
 */

export interface BuildProjectFileOptions {
  /** Default: the app's sample store. */
  store?: BlobStore;
  now?: Date;
  /** Embedded samples the store doesn't have. The file is still written, without their bytes. */
  onMissingSamples?(refs: SampleRef[]): void;
}

export interface OpenedProject {
  project: Project;
  /** Parsed view.json (unvalidated), or null. */
  view: unknown;
  /** Plain-language notes on what was fixed or is missing. */
  repairs: string[];
  migratedFrom: number;
  /** Embedded samples that are neither in the file nor in the store (they will be silent). */
  missingSamples: SampleRef[];
}

const embedded = (ref: SampleRef) => (ref.source.kind === 'embedded' ? ref.source : null);

/** Reads every embedded sample the project references from the store (one copy per hash). */
export async function collectEmbeddedSamples(
  project: Project,
  store: BlobStore = defaultSampleStore(),
): Promise<{ samples: Map<string, EmbeddedSample>; missing: SampleRef[] }> {
  const samples = new Map<string, EmbeddedSample>();
  const absent = new Set<string>();
  const missing: SampleRef[] = [];
  for (const ref of Object.values(project.samples)) {
    const src = embedded(ref);
    if (!src || samples.has(src.hash)) continue;
    if (!absent.has(src.hash)) {
      const blob = await store.getBlob(src.hash, src.ext);
      if (blob) {
        samples.set(src.hash, blob);
        continue;
      }
      absent.add(src.hash);
    }
    missing.push(ref);
  }
  return { samples, missing };
}

/** Builds a complete .agproj: the project, its view and every embedded sample it uses. */
export async function buildProjectFile(
  project: Project,
  view: unknown,
  appVersion: string,
  opts: BuildProjectFileOptions = {},
): Promise<Uint8Array> {
  const { samples, missing } = await collectEmbeddedSamples(project, opts.store);
  if (missing.length > 0) opts.onMissingSamples?.(missing);
  return writeProjectFile({ project, view, samples, appVersion, now: opts.now });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function describeSamples(refs: SampleRef[]): string {
  const names = refs.slice(0, 3).map((r) => `"${r.name}"`);
  return refs.length > 3 ? `${names.join(', ')} and ${refs.length - 3} more` : names.join(', ');
}

/**
 * Opens a project file (throws ProjectFileError with a user-facing message), verifies each embedded
 * sample against its hash and stores it before returning, so the engine can load it right away.
 */
export async function openProjectFile(bytes: Uint8Array, opts: { store?: BlobStore } = {}): Promise<OpenedProject> {
  const file = readProjectFile(bytes);
  const store = opts.store ?? defaultSampleStore();
  const repairs = [...file.repairs];
  let damaged = 0;
  for (const [hash, sample] of file.samples) {
    if (await store.hasBlob(hash, sample.ext)) continue;
    // Zip entries have no checksum verification in fflate; the content hash catches corruption, and
    // a wrong blob must never enter the content-addressed store.
    if ((await sha256Hex(sample.bytes)) !== hash) {
      damaged++;
      continue;
    }
    await store.putBlob(hash, sample.ext, sample.bytes);
  }
  if (damaged > 0) {
    repairs.push(`Skipped ${plural(damaged, 'damaged sample file', 'damaged sample files')} in this project file.`);
  }
  const missingSamples: SampleRef[] = [];
  const present = new Map<string, boolean>();
  for (const ref of Object.values(file.project.samples)) {
    const src = embedded(ref);
    if (!src) continue;
    let ok = present.get(src.hash);
    if (ok === undefined) {
      ok = await store.hasBlob(src.hash, src.ext);
      present.set(src.hash, ok);
    }
    if (!ok) missingSamples.push(ref);
  }
  if (missingSamples.length > 0) {
    const n = missingSamples.length;
    repairs.push(
      `${plural(n, 'sample is', 'samples are')} missing and will be silent: ${describeSamples(missingSamples)}.`,
    );
  }
  return { project: file.project, view: file.view, repairs, migratedFrom: file.migratedFrom, missingSamples };
}

function isAiff(bytes: Uint8Array): boolean {
  const tag = (o: number) =>
    String.fromCharCode(bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0, bytes[o + 3] ?? 0);
  return bytes.length >= 12 && tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC');
}

/**
 * Bytes that Chrome's decodeAudioData can read. AIFF/AIFC isn't supported there, so those are
 * re-encoded as 32-bit float WAV (lossless for PCM up to 24 bits); everything else passes through.
 */
export function decodableBytes(bytes: Uint8Array): Uint8Array {
  if (!isAiff(bytes)) return bytes;
  try {
    const pcm = decodePcm(bytes);
    if (!pcm || pcm.channels.length === 0) return bytes;
    return encodeWav(pcm.channels, Math.round(pcm.sampleRate), { bitDepth: 32 });
  } catch {
    return bytes;
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return whole && !isSharedMemory(bytes) ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
}

/**
 * The engine's source of embedded sample bytes (SampleCache decodes them per sample rate). AIFF is
 * transcoded to WAV unless `transcode` is false.
 */
export function opfsSampleProvider(opts: { store?: BlobStore; transcode?: boolean } = {}): SampleBytesProvider {
  return {
    async getBytes(ref) {
      const src = embedded(ref);
      if (!src) return null;
      const blob = await (opts.store ?? defaultSampleStore()).getBlob(src.hash, src.ext);
      if (!blob) return null;
      return exactArrayBuffer(opts.transcode === false ? blob.bytes : decodableBytes(blob.bytes));
    },
  };
}
