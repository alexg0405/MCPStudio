import { exactArrayBuffer } from '@core/io/bytes';
import { sha256Hex } from '@core/io/hash';
import {
  readProjectFile,
  readProjectFileIndex,
  writeProjectFile,
  writeProjectFileStream,
  type EmbeddedSample,
  type ProjectFileIndex,
} from '@core/io/project-file';
import { decodePcm, encodeWav } from '@core/io/wav';
import type { Project, SampleRef } from '@core/model/types';
import type { SampleBytesProvider } from '@engine/api';
import type { BlobStore } from '@platform/opfs';
import { defaultSampleStore } from './blob-store';
import { sniffAudioExt } from './sample-import';

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

/**
 * Writes a complete .agproj a piece at a time into `write` (a file handle's stream): each embedded
 * sample is read from the store only when it is written, so a project with hundreds of MB of songs
 * never sits in memory whole. Same contents as buildProjectFile.
 */
export async function writeProjectTo(
  write: (bytes: Uint8Array) => Promise<void>,
  project: Project,
  view: unknown,
  appVersion: string,
  opts: BuildProjectFileOptions = {},
): Promise<void> {
  const store = opts.store ?? defaultSampleStore();
  const byHash = new Map<string, SampleRef[]>();
  for (const ref of Object.values(project.samples)) {
    const src = embedded(ref);
    if (src) byHash.set(src.hash, [...(byHash.get(src.hash) ?? []), ref]);
  }
  const samples = [...byHash.entries()].map(([hash, refs]) => {
    const src = embedded(refs[0] as SampleRef)!;
    return {
      hash,
      ext: src.ext,
      read: () => store.getBlob(hash, src.ext),
    };
  });
  const { missing } = await writeProjectFileStream(
    { project, view, appVersion, now: opts.now, samples },
    write,
  );
  if (missing.length > 0) opts.onMissingSamples?.(missing.flatMap((h) => byHash.get(h) ?? []));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function describeSamples(refs: SampleRef[]): string {
  const names = refs.slice(0, 3).map((r) => `"${r.name}"`);
  return refs.length > 3 ? `${names.join(', ')} and ${refs.length - 3} more` : names.join(', ');
}

/**
 * For a recovered project: the samples whose audio isn't in the sample store, in plain words, with
 * their file names (Kick.wav). Null when every sound is there.
 */
export function missingSoundsNotice(refs: readonly SampleRef[]): string | null {
  if (refs.length === 0) return null;
  const names = refs.slice(0, 3).map((r) => {
    const src = embedded(r);
    return `"${src ? `${r.name}.${src.ext}` : r.name}"`;
  });
  const list = refs.length > 3 ? `${names.join(', ')} and ${refs.length - 3} more` : names.join(', ');
  return `${plural(refs.length, 'sound couldn’t', 'sounds couldn’t')} be found: ${list}. Use File → Find missing samples… to point to them.`;
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
  return finishOpen(file, repairs, damaged, store);
}

/**
 * Bytes that Chrome's decodeAudioData can read. AIFF/AIFC isn't supported there, so those are
 * re-encoded as 32-bit float WAV (lossless for PCM up to 24 bits); everything else passes through.
 */
export function decodableBytes(bytes: Uint8Array): Uint8Array {
  const kind = sniffAudioExt(bytes);
  if (kind !== 'aiff' && kind !== 'aifc') return bytes;
  try {
    const pcm = decodePcm(bytes);
    if (!pcm || pcm.channels.length === 0) return bytes;
    return encodeWav(pcm.channels, Math.round(pcm.sampleRate), { bitDepth: 32 });
  } catch {
    return bytes;
  }
}

/**
 * Opens a project file read a range at a time (a File from a picker or a drop): the project now,
 * then each embedded sample on its own (verified against its hash, stored), so opening a project
 * with hundreds of MB of songs holds one song at a time. Same result as openProjectFile.
 */
export async function openProjectBlob(blob: Blob, opts: { store?: BlobStore } = {}): Promise<OpenedProject> {
  const read = async (offset: number, length: number) =>
    new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer());
  const file: ProjectFileIndex = await readProjectFileIndex(read, blob.size);
  const store = opts.store ?? defaultSampleStore();
  const repairs = [...file.repairs];
  let damaged = 0;
  for (const [hash, sample] of file.samples) {
    if (await store.hasBlob(hash, sample.ext)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await sample.read();
    } catch {
      damaged++;
      continue;
    }
    if ((await sha256Hex(bytes)) !== hash) {
      damaged++;
      continue;
    }
    await store.putBlob(hash, sample.ext, bytes);
  }
  return finishOpen(file, repairs, damaged, store);
}

/** Reports damaged and missing samples of an opened project. */
async function finishOpen(
  file: { project: Project; view: unknown; migratedFrom: number },
  repairs: string[],
  damaged: number,
  store: BlobStore,
): Promise<OpenedProject> {
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
