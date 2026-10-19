/**
 * Audio export (File > Export audio): the song, the current pattern or the loop region as one WAV,
 * FLAC or MP3 file, or as stems (one file per mixer track, all the same length and aligned) into a
 * folder or a .zip. Renders with the same engine as playback (OfflineAudioContext, window by
 * window for long songs), trims the pre-roll and the mixer's delay compensation, encodes in a Worker
 * and writes the file as it goes: an hour-long mix is never in memory whole.
 */
import { normalizeGain } from '@core/audio/envelope';
import { planStems, stemProject, withoutMasterChain, type StemPlan } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import type { Project } from '@core/model/types';
import { measureTail } from '@engine/render-offline';
import { isFileSystemAccessSupported, pickDirectory, pickSaveExportFile } from '@platform/fs-access';
import { downloadParts, memorySink, openFileSink, openTempFile, type ByteSink, type MemorySink } from '@platform/sinks';
import type { PrefsState } from '../stores/prefs';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import {
  CODEC_EXTENSIONS,
  CODEC_MIME,
  MP3_SAMPLE_RATES,
  openEncodeStream,
  type AudioCodec,
  type EncodeSpec,
} from './encode';
import { ExportError, type ExportProgress } from './export-wav';
import { renderPass } from './render-pass';
import { ZipStream } from './zip-stream';
import { planExport, planSeconds, type ExportPlan, type ExportRange } from './plan';

export interface AudioExportSettings {
  range: ExportRange;
  codec: AudioCodec;
  /** WAV: 16 (dithered), 24, or 32 (float). */
  wavBits: 16 | 24 | 32;
  flacBits: 16 | 24;
  mp3Kbps: number;
  sampleRate: number;
  /** Raise (or lower) the whole export so its loudest moment peaks at −0.3 dBFS. */
  normalize: boolean;
  /** One file per mixer track instead of the mix. */
  stems: boolean;
  /** Stems: each one goes through the master's effects and fader (off: raw, as they reach the master). */
  masterChain: boolean;
  /** Stems go into a folder (File System Access) or a .zip. */
  stemsTo: 'folder' | 'zip';
}

export const MP3_BITRATES = [128, 192, 256, 320] as const;

/** The export settings remembered in the prefs. */
export function exportSettingsFrom(p: PrefsState, range: ExportRange): AudioExportSettings {
  return {
    range,
    codec: p.exportCodec,
    wavBits: p.exportFormat === 'pcm16' ? 16 : p.exportFormat === 'float32' ? 32 : 24,
    flacBits: p.exportFlacBits === 16 ? 16 : 24,
    mp3Kbps: p.exportMp3Kbps,
    sampleRate: p.exportSampleRate,
    normalize: p.exportNormalize,
    stems: p.exportStems,
    masterChain: p.exportMasterChain,
    stemsTo: p.exportStemsTo,
  };
}

/** The sample rate actually written (MP3 holds at most 48 kHz). */
export function effectiveRate(s: Pick<AudioExportSettings, 'codec' | 'sampleRate'>): number {
  if (s.codec !== 'mp3' || MP3_SAMPLE_RATES.includes(s.sampleRate)) return s.sampleRate;
  return 48000;
}

export function encodeSpecOf(s: AudioExportSettings): EncodeSpec {
  return {
    codec: s.codec,
    bits: s.codec === 'flac' ? s.flacBits : s.codec === 'wav' ? s.wavBits : 16,
    kbps: s.mp3Kbps,
  };
}

/** "song.flac", "song – 03 Drums.wav". */
export function exportFileName(base: string, codec: AudioCodec, stem?: StemPlan): string {
  const clean = base.replace(/\.(agproj|wav|flac|mp3|zip)$/i, '').trim() || 'Untitled';
  return `${stem ? `${clean} - ${stem.name}` : clean}.${CODEC_EXTENSIONS[codec]}`;
}

export type ExportTarget =
  | { kind: 'file'; handle: FileSystemFileHandle; name: string }
  | { kind: 'download'; name: string }
  | { kind: 'folder'; dir: FileSystemDirectoryHandle; name: string }
  | { kind: 'zip'; handle: FileSystemFileHandle | null; name: string }
  /** Files kept in memory (tests, and tools that hand the bytes on): stems go in one by one, or as a .zip. */
  | { kind: 'memory'; files: Map<string, Uint8Array>; name: string };

/**
 * Asks where the export goes: a file (or a folder for stems, or a .zip). Pickers need a user gesture,
 * so call this first, right from the click. Null when the user cancels. Without File System Access the
 * file (or the .zip) is downloaded.
 */
export async function chooseExportTarget(base: string, s: AudioExportSettings): Promise<ExportTarget | null> {
  const fsa = isFileSystemAccessSupported();
  if (s.stems) {
    const zipName = exportFileName(base, s.codec).replace(/\.[a-z0-9]+$/, ' (stems).zip');
    if (s.stemsTo === 'folder' && fsa) {
      const dir = await pickDirectory('export-stems', 'readwrite');
      return dir ? { kind: 'folder', dir, name: dir.name } : null;
    }
    if (!fsa) return { kind: 'zip', handle: null, name: zipName };
    const handle = await pickSaveExportFile(zipName, 'zip');
    return handle ? { kind: 'zip', handle, name: handle.name } : null;
  }
  const name = exportFileName(base, s.codec);
  if (!fsa) return { kind: 'download', name };
  const handle = await pickSaveExportFile(name, CODEC_EXTENSIONS[s.codec]);
  return handle ? { kind: 'file', handle, name: handle.name } : null;
}

export interface ExportResult {
  /** Files written (one, or one per stem). */
  names: string[];
  seconds: number;
}

export interface ExportHooks {
  onProgress?(p: ExportProgress & { label?: string }): void;
  signal?: AbortSignal;
}

function peakOf(channels: readonly Float32Array[]): number {
  let m = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i] as number));
  return m;
}

function scale(channels: readonly Float32Array[], gain: number): void {
  if (gain === 1) return;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] = (c[i] as number) * gain;
}

/** Where one exported file's bytes go as they are encoded (a download or `memory` target collects them). */
export async function sinkFor(target: ExportTarget, mime: string): Promise<{ sink: ByteSink; done(): Promise<void> }> {
  if ((target.kind === 'file' || target.kind === 'zip') && target.handle) {
    const sink = await openFileSink(target.handle);
    return { sink, done: () => sink.close() };
  }
  const mem = memorySink();
  return {
    sink: mem,
    done: async () => {
      if (target.kind === 'memory') target.files.set(target.name, mem.bytes());
      else downloadParts(target.name, mem.parts(), mime);
    },
  };
}

/**
 * Encodes pieces of audio into a sink as they come: the file's header first, the encoded pieces,
 * then the end, and the header again with the final sizes (WAV, FLAC).
 */
async function encoderInto(sink: ByteSink, spec: EncodeSpec, rate: number, channels: number) {
  const enc = await openEncodeStream(spec, rate, channels);
  await sink.write(enc.header);
  let chain: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  return {
    /** Queues a piece (transferred to the encoder); resolves when there is room for the next one. */
    async push(piece: Float32Array[]): Promise<void> {
      if (failed) throw failed;
      const encoded = enc.push(piece);
      chain = chain.then(async () => sink.write(await encoded)).catch((e: unknown) => {
        failed ??= e;
      });
      // At most one piece waits to be written: memory stays at a few seconds of audio.
      await chain;
      if (failed) throw failed;
    },
    async finish(): Promise<void> {
      await chain;
      if (failed) throw failed;
      const { tail, header } = await enc.finish();
      await sink.write(tail);
      if (header) await sink.writeAt(0, header);
    },
    close: () => enc.close(),
  };
}

/**
 * Renders and writes the export, a piece at a time: the render streams window by window
 * (renderStream), is trimmed as it comes (StreamTrimmer), encoded in a Worker and written to the
 * file as it goes, so an hour-long mix is never held whole. Normalizing a mix renders it twice
 * (once to find the peak). Stems: the mix is rendered first (for the common length and the
 * normalize gain), then each stem with the same tail, cut to the same length, raised by the same
 * gain, so the stems still add up to the mix. Rejects with ExportError (or an AbortError).
 */
export function runExport(
  s: Services,
  settings: AudioExportSettings,
  target: ExportTarget,
  hooks: ExportHooks = {},
): Promise<ExportResult> {
  // The project as it is now keeps all its audio until the export is done, even if a sample is deleted meanwhile.
  return whileBusy(() => runExportOf(s, s.doc.getState().project, settings, target, hooks), {
    project: s.doc.getState().project,
  });
}

/** Everything one export run shares: what to render, how to encode it, and (once measured) how long and how loud it is. */
interface ExportRun {
  s: Services;
  settings: AudioExportSettings;
  hooks: ExportHooks;
  plan: ExportPlan;
  rate: number;
  spec: EncodeSpec;
  /** The project to render: the master's effects and fader taken out for raw stems. */
  base: Project;
  /** Raw stems: no limiter, and the master's chain is out. */
  isRaw: boolean;
  stems: StemPlan[];
  /** Silence after the music for effect tails, in seconds (measured once, shared by every render of the run). */
  tail: number;
  musicFrames: number;
  /** Renders in this run: the measuring pass (if any) and the files. Progress is spread over them. */
  steps: number;
  /** Set by `measureMix` when a mix is measured first (stems, normalize): the common length in frames, and the gain. */
  length: number | undefined;
  gain: number;
  /** The step number of the first file render (1 when a measuring pass came first). */
  firstStep: number;
}

/** Works out what the export renders (rejects with a plain message when there is nothing to export). */
async function prepareExport(s: Services, project: Project, settings: AudioExportSettings, hooks: ExportHooks): Promise<ExportRun> {
  const plan = planExport(project, s.view.getState(), settings.range);
  if ('error' in plan) throw new ExportError(plan.error);
  s.engine.stop();
  const rate = effectiveRate(settings);
  const musical = planSeconds(project, plan);
  const isRaw = settings.stems && !settings.masterChain;
  const base = isRaw ? withoutMasterChain(project) : project;
  const stems = settings.stems ? planStems(base, stemRange(base, plan)) : [];
  if (settings.stems && stems.length === 0) throw new ExportError('Nothing plays in this range, so there are no stems to export.');
  const isMeasuringMix = settings.stems || settings.normalize;
  const steps = (settings.stems ? stems.length : 1) + (isMeasuringMix ? 1 : 0);
  const tail = await measureTail(base, { plugins: s.plugins, sampleCache: s.sampleCache }, rate);
  hooks.signal?.throwIfAborted();
  return {
    s,
    settings,
    hooks,
    plan,
    rate,
    spec: encodeSpecOf(settings),
    base,
    isRaw,
    stems,
    tail,
    musicFrames: Math.ceil(musical * rate),
    steps,
    length: undefined,
    gain: 1,
    firstStep: isMeasuringMix ? 1 : 0,
  };
}

/** One render pass of the run; every kept piece goes to `consume`. Returns the frames kept. */
function renderStep(
  run: ExportRun,
  project: Project,
  step: number,
  label: string,
  length: number | undefined,
  consume: (piece: Float32Array[]) => Promise<void>,
): Promise<number> {
  const { s, plan, rate, tail, musicFrames, steps, hooks } = run;
  return renderPass(
    {
      s,
      project,
      plan,
      sampleRate: rate,
      tail,
      musicFrames,
      limiter: !run.isRaw,
      length,
      signal: hooks.signal,
      onRender: (f) => hooks.onProgress?.({ stage: 'render', fraction: ((step + f) / steps) * 0.98, label }),
    },
    consume,
  );
}

/** The mix's length and peak (for stems and normalize): a pass that only measures. Sets the run's common length and gain. */
async function measureMix(run: ExportRun): Promise<void> {
  const label = run.settings.stems ? 'Mix (for the length)' : 'Mix (for the level)';
  let peak = 0;
  run.length = await renderStep(run, run.base, 0, label, undefined, async (piece) => {
    peak = Math.max(peak, peakOf(piece));
  });
  if (run.settings.normalize) run.gain = normalizeGain(peak);
}

/** Renders `project` and encodes it into `sink`, scaled by the run's gain. Returns the frames written. */
async function renderInto(run: ExportRun, project: Project, step: number, label: string, sink: ByteSink, fixedLength: number | undefined): Promise<number> {
  const enc = await encoderInto(sink, run.spec, run.rate, 2);
  try {
    const frames = await renderStep(run, project, step, label, fixedLength, async (piece) => {
      // The render's arrays are ours: scaled in place, then handed to the encoder.
      const own = piece.map((c) => (c.byteOffset === 0 && c.length === c.buffer.byteLength / 4 ? c : c.slice()));
      scale(own, run.gain);
      await enc.push(own);
    });
    await enc.finish();
    return frames;
  } catch (e) {
    enc.close();
    throw e;
  }
}

/** The mix as one file. */
async function exportMixFile(run: ExportRun, target: ExportTarget): Promise<ExportResult> {
  const { sink, done } = await sinkFor(target, CODEC_MIME[run.settings.codec]);
  try {
    const frames = await renderInto(run, run.base, run.firstStep, 'Mix', sink, run.length);
    await done();
    run.hooks.onProgress?.({ stage: 'encode', fraction: 1 });
    return { names: [target.name], seconds: frames / run.rate };
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

/** One stem into a folder, as a file of its own. */
async function exportStemToFolder(run: ExportRun, target: Extract<ExportTarget, { kind: 'folder' }>, variant: Project, step: number, stem: StemPlan, name: string): Promise<void> {
  const sink = await openFileSink(await target.dir.getFileHandle(name, { create: true }));
  try {
    await renderInto(run, variant, step, stem.name, sink, run.length);
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

/**
 * One stem into a .zip: it is encoded to a temporary file (its header is patched at the end), then copied into the zip as a
 * stored entry. Without a temporary file (no OPFS) it is held in memory instead.
 */
async function exportStemToZip(run: ExportRun, zip: ZipStream, variant: Project, step: number, stem: StemPlan, name: string): Promise<void> {
  const temp = await openTempFile('stem');
  const sink = temp?.sink ?? memorySink();
  try {
    await renderInto(run, variant, step, stem.name, sink, run.length);
    await sink.close();
    await zip.addFile(name, temp ? await temp.file() : new Blob((sink as MemorySink).parts() as BlobPart[]));
  } finally {
    await temp?.remove();
  }
}

/** The stems: one file each into a folder (or memory), or all streamed into one .zip. */
async function exportStemFiles(run: ExportRun, target: ExportTarget): Promise<ExportResult> {
  const { settings, hooks, stems, base, firstStep } = run;
  const projectName = run.s.files.store.getState().name;
  const names: string[] = [];
  const isOneByOne = target.kind === 'folder' || (target.kind === 'memory' && settings.stemsTo === 'folder');
  // A .zip is streamed too: each stem goes through a temporary file, then into the zip.
  const zipOut = isOneByOne ? null : await sinkFor(target, 'application/zip');
  const zip = zipOut ? new ZipStream(zipOut.sink) : null;
  try {
    for (const [i, stem] of stems.entries()) {
      const name = exportFileName(projectName, settings.codec, stem);
      names.push(name);
      const variant = stemProject(base, stems, stem);
      if (target.kind === 'folder') {
        await exportStemToFolder(run, target, variant, firstStep + i, stem, name);
      } else if (isOneByOne && target.kind === 'memory') {
        const mem = memorySink();
        await renderInto(run, variant, firstStep + i, stem.name, mem, run.length);
        target.files.set(name, mem.bytes());
      } else {
        await exportStemToZip(run, zip!, variant, firstStep + i, stem, name);
      }
    }
    if (zip && zipOut) {
      hooks.onProgress?.({ stage: 'encode', fraction: 0.99, label: 'Zip' });
      await zip.finish();
      await zipOut.done();
    }
  } catch (e) {
    await zipOut?.sink.abort();
    throw e;
  }
  hooks.onProgress?.({ stage: 'encode', fraction: 1 });
  return { names, seconds: (run.length ?? 0) / run.rate };
}

/** Runs one export: prepare, measure the mix when its length or level is needed, then write the mix or the stems. */
async function runExportOf(s: Services, project: Project, settings: AudioExportSettings, target: ExportTarget, hooks: ExportHooks): Promise<ExportResult> {
  const run = await prepareExport(s, project, settings, hooks);
  if (settings.stems || settings.normalize) await measureMix(run);
  return settings.stems ? exportStemFiles(run, target) : exportMixFile(run, target);
}

function stemRange(project: Project, plan: ExportPlan) {
  const toTick = plan.fromTick + plan.bars * ticksPerBar(project.transport.timeSig);
  return { mode: plan.mode, patternId: plan.patternId, fromTick: plan.fromTick, toTick };
}
