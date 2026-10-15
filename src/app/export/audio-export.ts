/**
 * Audio export (File > Export audio): the song, the current pattern or the loop region as one WAV,
 * FLAC or MP3 file, or as stems (one file per mixer track, all the same length and aligned) into a
 * folder or a .zip. Renders with the same engine as playback (OfflineAudioContext), trims the
 * pre-roll and the mixer's delay compensation, and encodes in a Worker.
 */
import { zipSync } from 'fflate';
import { normalizeGain } from '@core/audio/envelope';
import { planStems, stemProject, withoutMasterChain, type StemPlan } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import type { Project } from '@core/model/types';
import { measureTail, renderOffline } from '@engine/render-offline';
import {
  downloadBytes,
  isFileSystemAccessSupported,
  pickDirectory,
  pickSaveExportFile,
  writeFile,
  writeFileInDirectory,
} from '@platform/fs-access';
import type { PrefsState } from '../stores/prefs';
import type { Services } from '../services';
import {
  CODEC_EXTENSIONS,
  CODEC_MIME,
  MP3_SAMPLE_RATES,
  encodeOffThread,
  type AudioCodec,
  type EncodeSpec,
} from './encode';
import { ExportError, trimExport, type ExportProgress } from './export-wav';
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

function peakOf(channels: Float32Array[]): number {
  let m = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i] as number));
  return m;
}

function scale(channels: Float32Array[], gain: number): void {
  if (gain === 1) return;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] = (c[i] as number) * gain;
}

/**
 * Renders and writes the export. Stems: the mix is rendered first (for the common length and the
 * normalize gain), then each stem with the same tail, cut to the same length, raised by the same
 * gain, so the stems still add up to the mix. Rejects with ExportError (or an AbortError).
 */
export async function runExport(
  s: Services,
  settings: AudioExportSettings,
  target: ExportTarget,
  hooks: ExportHooks = {},
): Promise<ExportResult> {
  const project = s.doc.getState().project;
  const plan = planExport(project, s.view.getState(), settings.range);
  if ('error' in plan) throw new ExportError(plan.error);
  s.engine.stop();
  const rate = effectiveRate(settings);
  const spec = encodeSpecOf(settings);
  const musical = planSeconds(project, plan);
  const raw = settings.stems && !settings.masterChain;
  const base = raw ? withoutMasterChain(project) : project;
  const engineOpts = { plugins: s.plugins, sampleCache: s.sampleCache };
  const stems = settings.stems ? planStems(base, stemRange(base, plan)) : [];
  if (settings.stems && stems.length === 0)
    throw new ExportError('Nothing plays in this range, so there are no stems to export.');
  const steps = settings.stems ? stems.length + 1 : 1;
  const signal = hooks.signal;
  const tail = await measureTail(base, engineOpts, rate);
  signal?.throwIfAborted();

  const render = async (p: Project, step: number, label: string) => {
    const result = await renderOffline(p, {
      ...engineOpts,
      view: { mode: plan.mode, patternId: plan.patternId, loop: null },
      bars: plan.bars,
      fromTick: plan.fromTick,
      sampleRate: rate,
      tail,
      limiter: !raw,
      onProgress: (f) => hooks.onProgress?.({ stage: 'render', fraction: ((step + f) / steps) * 0.9, label }),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    return result;
  };

  const mix = await render(base, 0, settings.stems ? 'Mix (for the length)' : 'Mix');
  const mixChannels = trimExport(mix, musical);
  const length = mixChannels[0]?.length ?? 0;
  const gain = settings.normalize ? normalizeGain(peakOf(mixChannels)) : 1;
  const seconds = length / rate;
  const projectName = s.files.store.getState().name;

  if (!settings.stems) {
    scale(mixChannels, gain);
    hooks.onProgress?.({ stage: 'encode', fraction: 0.92 });
    const bytes = await encodeOffThread(mixChannels, rate, spec);
    signal?.throwIfAborted();
    await write(target, target.name, bytes, CODEC_MIME[settings.codec]);
    hooks.onProgress?.({ stage: 'encode', fraction: 1 });
    return { names: [target.name], seconds };
  }

  const zip: Record<string, [Uint8Array, { level: 0 }]> = {};
  const names: string[] = [];
  const oneByOne = target.kind === 'folder' || (target.kind === 'memory' && settings.stemsTo === 'folder');
  for (const [i, stem] of stems.entries()) {
    const r = await render(stemProject(base, stems, stem), i + 1, stem.name);
    // Every stem has the mix's start and length (same render length and latency, see measureTail).
    const start = Math.round((r.preRoll + r.latency) * rate);
    const channels = Array.from({ length: r.buffer.numberOfChannels }, (_, c) =>
      r.buffer.getChannelData(c).slice(start, start + length),
    );
    scale(channels, gain);
    hooks.onProgress?.({ stage: 'encode', fraction: ((i + 1.9) / steps) * 0.9, label: stem.name });
    const bytes = await encodeOffThread(channels, rate, spec);
    signal?.throwIfAborted();
    const name = exportFileName(projectName, settings.codec, stem);
    names.push(name);
    if (target.kind === 'folder') await writeFileInDirectory(target.dir, name, bytes);
    else if (oneByOne && target.kind === 'memory') target.files.set(name, bytes);
    else zip[name] = [bytes, { level: 0 }];
  }
  if (!oneByOne) {
    hooks.onProgress?.({ stage: 'encode', fraction: 0.97, label: 'Zip' });
    await write(target, target.name, zipSync(zip), 'application/zip');
  }
  hooks.onProgress?.({ stage: 'encode', fraction: 1 });
  return { names, seconds };
}

function stemRange(project: Project, plan: ExportPlan) {
  const toTick = plan.fromTick + plan.bars * ticksPerBar(project.transport.timeSig);
  return { mode: plan.mode, patternId: plan.patternId, fromTick: plan.fromTick, toTick };
}

async function write(target: ExportTarget, name: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (target.kind === 'memory') target.files.set(name, bytes);
  else if ((target.kind === 'file' || target.kind === 'zip') && target.handle) await writeFile(target.handle, bytes);
  else downloadBytes(name, bytes, mime);
}
