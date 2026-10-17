/**
 * FL Studio projects in: an .flp, or FL's zipped loop package (the .flp plus its samples), opens as
 * a new unsaved project (like opening a file: the old one is replaced after the unsaved-changes
 * question, undo history starts empty). Samples found in the package are decoded, stored in the
 * sample store and embedded; missing ones keep a named placeholder (silent) that "Find missing
 * samples" later fills from audio files or a zip, matched by file name.
 */
import { sha256Hex } from '@core/io/hash';
import { FlpError, flpFileName, flpSamplePaths, parseFlp, type FlpProject } from '@core/io/flp';
import { describeFlpImport, flpToProject, type FlpImportReport, type FlpResolvedSample } from '@core/io/flp-import';
import { isZip, matchSampleFile, readFlpPackage, readZipAudio, type FlpPackageFile } from '@core/io/flp-package';
import { normalizeSampleExt } from '@core/io/project-file';
import { newId } from '@core/model/ids';
import type { Project, SampleId, SampleRef } from '@core/model/types';
import { repairProject } from '@core/schema/migrate';
import type { BlobStore } from '@platform/opfs';
import { AUDIO_EXTENSIONS, uploadFile, uploadFiles } from '@platform/fs-access';
import { defaultValues } from '@agstudio/sdk';
import { defaultSampleStore } from '../persistence/blob-store';
import { importSampleBytes } from '../persistence/sample-import';
import type { Services } from '../services';
import { probeAudio } from './samples';

export const FLP_ACCEPT = '.flp,.zip,application/zip';

type FileLike = Pick<File, 'name' | 'arrayBuffer'>;

export interface FlpImportOutcome {
  /** The new project's name (the file name without extension). */
  name: string;
  report: FlpImportReport;
  /** The samples came in a zipped loop package. */
  fromPackage: boolean;
  /** Plain-language summary (headline + detail lines) for the import report. */
  headline: string;
  details: string[];
}

interface Source {
  flp: FlpProject;
  audio: FlpPackageFile[];
  fromPackage: boolean;
  name: string;
}

/** Reads an .flp or a zipped loop package (throws FlpError with a readable message). */
export function readFlpSource(bytes: Uint8Array, fileName: string): Source {
  if (isZip(bytes)) {
    const pkg = readFlpPackage(bytes);
    const name = fileName.replace(/\.zip$/i, '').trim() || pkg.flpName.replace(/\.flp$/i, '');
    return { flp: parseFlp(pkg.flp), audio: pkg.audio, fromPackage: true, name };
  }
  return { flp: parseFlp(bytes), audio: [], fromPackage: false, name: fileName.replace(/\.flp$/i, '').trim() };
}

const stem = (file: string) => file.replace(/\.[^.]+$/, '');

/** A sample that wasn't found: named after the file, pointing at audio nobody has (yet). */
async function placeholderRef(path: string): Promise<SampleRef> {
  const file = flpFileName(path) || 'Sample';
  const dot = file.lastIndexOf('.');
  const ext = (dot > 0 ? normalizeSampleExt(file.slice(dot + 1)) : null) ?? 'wav';
  // A stable, valid content key that no real audio has (the hash of a label, not of audio).
  const hash = await sha256Hex(new TextEncoder().encode(`agstudio:missing-sample:${path}`));
  return {
    id: newId.sample(),
    name: stem(file).slice(0, 128) || 'Sample',
    source: { kind: 'embedded', hash, ext, originalName: file },
  };
}

/** Finds, decodes and stores each sample the project uses (placeholders for the missing ones). */
async function resolveSamples(
  paths: string[],
  audio: FlpPackageFile[],
  store: BlobStore,
): Promise<Map<string, FlpResolvedSample>> {
  const out = new Map<string, FlpResolvedSample>();
  const byFile = new Map<string, SampleRef | null>();
  for (const path of paths) {
    const file = matchSampleFile(path, audio);
    let ref: SampleRef | null = null;
    if (file) {
      if (byFile.has(file.path)) ref = byFile.get(file.path) ?? null;
      else {
        const facts = await probeAudio(file.bytes);
        if (facts) ref = { ...(await importSampleBytes(file.bytes, flpFileName(file.path), { store })), ...facts };
        byFile.set(file.path, ref);
      }
    }
    out.set(path, ref ? { ref, found: true } : { ref: await placeholderRef(path), found: false });
  }
  return out;
}

/** Builds the project for an FL file without opening it (exported for tests and the AI). */
export async function buildFlpImport(
  s: Services,
  source: Source,
  opts: { store?: BlobStore; now?: Date } = {},
): Promise<{
  project: Project;
  outcome: FlpImportOutcome;
  firstPatternId: Project['patternOrder'][number];
  hasSong: boolean;
}> {
  const store = opts.store ?? defaultSampleStore();
  const samples = await resolveSamples(flpSamplePaths(source.flp), source.audio, store);
  const result = flpToProject(source.flp, {
    fileName: source.name,
    samples,
    fromPackage: source.fromPackage,
    ...(opts.now ? { now: opts.now } : {}),
    plugin: (id) => {
      const def = s.plugins.get(id);
      return def ? { version: def.version, params: defaultValues(def.params), name: def.name } : undefined;
    },
  });
  const repaired = repairProject(result.project);
  if (repaired.repairs.length > 0) console.warn(`FL Studio import fixes:\n- ${repaired.repairs.join('\n- ')}`);
  const { headline, details } = describeFlpImport(result.report, { fromPackage: source.fromPackage });
  return {
    project: repaired.project,
    outcome: { name: source.name, report: result.report, fromPackage: source.fromPackage, headline, details },
    firstPatternId: result.firstPatternId,
    hasSong: result.hasSong,
  };
}

/**
 * Imports an FL Studio file as a new, unsaved project. Resolves null when the user kept the open
 * project (unsaved-changes question); throws FlpError for files that can't be read.
 */
export async function importFlpFile(
  s: Services,
  file: FileLike,
  opts: { store?: BlobStore; now?: Date } = {},
): Promise<FlpImportOutcome | null> {
  let source: Source;
  try {
    source = readFlpSource(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (e) {
    throw e instanceof FlpError ? e : new FlpError(`${file.name} couldn't be read as an FL Studio project.`);
  }
  if (!(await s.files.confirmReplace())) return null;
  const built = await buildFlpImport(s, source, opts);
  s.files.replace(
    built.project,
    null,
    { name: built.outcome.name || 'FL Studio project', handle: null, fileKey: null },
    { dirty: true },
  );
  const view = s.view.getState();
  view.setCurrentPattern(built.firstPatternId);
  view.setMode(built.hasSong ? 'song' : 'pattern');
  return built.outcome;
}

/** The browser's file chooser for FL projects (null when cancelled). */
export function pickFlpFile(): Promise<File | null> {
  return uploadFile(FLP_ACCEPT);
}

/** Embedded samples of the open project whose audio is in no store (they play silence). */
export async function missingSamples(s: Services, store: BlobStore = defaultSampleStore()): Promise<SampleRef[]> {
  const out: SampleRef[] = [];
  for (const ref of Object.values(s.doc.getState().project.samples)) {
    if (ref.source.kind === 'embedded' && !(await store.hasBlob(ref.source.hash, ref.source.ext))) out.push(ref);
  }
  return out;
}

export interface RelinkResult {
  /** Names of the samples that now have their audio. */
  found: string[];
  /** Missing samples still without audio. */
  stillMissing: string[];
}

/**
 * Fills missing samples from audio files (or zips of them), matched by file name, in one undo
 * step: every channel, pad and audio clip that used a missing sample plays the found file.
 */
export async function relinkMissingSamples(
  s: Services,
  files: readonly FileLike[],
  opts: { store?: BlobStore } = {},
): Promise<RelinkResult> {
  const store = opts.store ?? defaultSampleStore();
  const missing = await missingSamples(s, store);
  const pool: FlpPackageFile[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isZip(bytes)) {
      try {
        pool.push(...readZipAudio(bytes));
      } catch {
        /* a damaged zip: nothing to take from it */
      }
    } else pool.push({ path: f.name, bytes });
  }
  const swaps = new Map<SampleId, SampleRef>();
  const byFile = new Map<string, SampleRef | null>();
  for (const ref of missing) {
    const want =
      ref.source.kind === 'embedded' ? (ref.source.originalName ?? `${ref.name}.${ref.source.ext}`) : ref.name;
    const file = matchSampleFile(want, pool);
    if (!file) continue;
    let next = byFile.get(file.path);
    if (next === undefined) {
      const facts = await probeAudio(file.bytes);
      next = facts ? { ...(await importSampleBytes(file.bytes, flpFileName(file.path), { store })), ...facts } : null;
      byFile.set(file.path, next);
    }
    if (next) swaps.set(ref.id, { ...next, id: newId.sample(), name: ref.name });
  }
  if (swaps.size > 0) {
    s.history.transact(swaps.size === 1 ? 'Find missing sample' : `Find ${swaps.size} missing samples`, (d) => {
      const swap = (id: SampleId | undefined) => (id && swaps.get(id)?.id) || id;
      for (const ref of swaps.values()) d.samples[ref.id] = ref;
      for (const ch of Object.values(d.channels)) {
        if (ch.kind === 'audioClip') ch.sampleId = swap(ch.sampleId) as SampleId;
        else if (ch.kind === 'instrument' && ch.plugin.samples)
          for (const [slot, id] of Object.entries(ch.plugin.samples)) ch.plugin.samples[slot] = swap(id) as SampleId;
      }
      for (const ins of Object.values(d.mixer.inserts))
        for (const fx of ins.fx)
          if (fx.plugin.samples)
            for (const [slot, id] of Object.entries(fx.plugin.samples)) fx.plugin.samples[slot] = swap(id) as SampleId;
      // A DJ mix names its songs by sample id, and tweaks its transitions by the incoming song's id.
      if (d.dj) {
        for (const song of d.dj.songs) song.sampleId = swap(song.sampleId) as SampleId;
        for (const [id, tweak] of Object.entries(d.dj.tweaks)) {
          const to = swap(id as SampleId);
          if (to && to !== id) {
            d.dj.tweaks[to] = tweak;
            delete d.dj.tweaks[id];
          }
        }
      }
      // The reference song is a sample of the project too.
      if (d.reference?.sampleId) d.reference.sampleId = swap(d.reference.sampleId) as SampleId;
      for (const id of swaps.keys()) delete d.samples[id];
    });
  }
  return {
    found: missing.filter((r) => swaps.has(r.id)).map((r) => r.name),
    stillMissing: missing.filter((r) => !swaps.has(r.id)).map((r) => r.name),
  };
}

/** The browser's file chooser for audio files and zips (empty when cancelled). */
export function pickSampleFiles(): Promise<File[]> {
  return uploadFiles(['audio/*', '.zip', ...AUDIO_EXTENSIONS.map((e) => `.${e}`)].join(','));
}
