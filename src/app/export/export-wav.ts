import { encodeWav } from '@core/io/wav';
import { renderOffline } from '@engine/render-offline';
import { downloadBytes, isFileSystemAccessSupported, pickSaveWavFile, writeFile } from '@platform/fs-access';
import { opfsSampleProvider } from '../persistence/project-io';
import type { Services } from '../services';
import { planExport, type ExportRange } from './plan';

/**
 * WAV export: renders with the same engine code as playback (OfflineAudioContext), drops the
 * pre-roll and the silence after the last tail, and encodes in a Worker.
 */
export type WavFormat = 'pcm16' | 'pcm24' | 'float32';

export interface WavExportOptions {
  range: ExportRange;
  format: WavFormat;
  sampleRate: number;
}

export const WAV_FORMATS: { value: WavFormat; label: string }[] = [
  { value: 'pcm16', label: '16-bit PCM (dithered)' },
  { value: 'pcm24', label: '24-bit PCM' },
  { value: 'float32', label: '32-bit float' },
];

export class ExportError extends Error {}

export interface ExportProgress {
  stage: 'render' | 'encode';
  /** 0..1 over the whole export. */
  fraction: number;
}

/** Below this the tail counts as silence (-90 dBFS, under one 16-bit step). */
const SILENCE = 10 ** (-90 / 20);

/** The music from its first beat to the end of the last audible tail. */
export function trimRender(buffer: AudioBuffer, preRoll: number, musicSeconds: number): Float32Array[] {
  const sr = buffer.sampleRate;
  const start = Math.min(buffer.length, Math.round(preRoll * sr));
  const musicEnd = Math.min(buffer.length, start + Math.ceil(musicSeconds * sr));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  let end = musicEnd;
  for (const ch of channels) {
    for (let i = ch.length - 1; i >= end; i--) {
      if (Math.abs(ch[i] as number) > SILENCE) {
        end = i + 1;
        break;
      }
    }
  }
  end = Math.min(buffer.length, end + Math.round(0.01 * sr));
  return channels.map((ch) => ch.slice(start, end));
}

function encodeOptions(format: WavFormat) {
  return format === 'pcm16'
    ? ({ bitDepth: 16, dither: true } as const)
    : format === 'pcm24'
      ? ({ bitDepth: 24, dither: false } as const)
      : ({ bitDepth: 32, dither: false } as const);
}

/** Encodes in a Worker when there is one (the main thread otherwise, e.g. in tests). */
export function encodeWavOffThread(
  channels: Float32Array[],
  sampleRate: number,
  format: WavFormat,
): Promise<Uint8Array> {
  const { bitDepth, dither } = encodeOptions(format);
  if (typeof Worker === 'undefined')
    return Promise.resolve(encodeWav(channels, sampleRate, { bitDepth, dither, seed: 1 }));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./wav-encode.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.bytes);
      else reject(new ExportError(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new ExportError(e.message || 'The WAV encoder failed.'));
    };
    worker.postMessage(
      { channels, sampleRate, bitDepth, dither },
      channels.map((c) => c.buffer as ArrayBuffer),
    );
  });
}

/** Renders the project and returns the WAV file. Rejects with ExportError (or an AbortError). */
export async function renderWav(
  s: Services,
  opts: WavExportOptions,
  hooks: { onProgress?(p: ExportProgress): void; signal?: AbortSignal } = {},
): Promise<{ bytes: Uint8Array; seconds: number }> {
  const project = s.doc.getState().project;
  const plan = planExport(project, s.view.getState(), opts.range);
  if ('error' in plan) throw new ExportError(plan.error);
  s.engine.stop();
  const ts = project.transport.timeSig;
  const barSeconds = (ts.num * 4 * 60) / (ts.den * project.transport.bpm);
  const result = await renderOffline(project, {
    plugins: s.plugins,
    samples: opfsSampleProvider(),
    view: { mode: plan.mode, patternId: plan.patternId, loop: null },
    bars: plan.bars,
    fromTick: plan.fromTick,
    sampleRate: opts.sampleRate,
    tail: 'auto',
    onProgress: (f) => hooks.onProgress?.({ stage: 'render', fraction: f * 0.9 }),
    signal: hooks.signal,
  });
  hooks.signal?.throwIfAborted();
  const channels = trimRender(result.buffer, result.preRoll, plan.bars * barSeconds);
  const seconds = (channels[0]?.length ?? 0) / opts.sampleRate;
  hooks.onProgress?.({ stage: 'encode', fraction: 0.92 });
  const bytes = await encodeWavOffThread(channels, opts.sampleRate, opts.format);
  hooks.signal?.throwIfAborted();
  hooks.onProgress?.({ stage: 'encode', fraction: 1 });
  return { bytes, seconds };
}

export type WavTarget =
  { kind: 'file'; handle: FileSystemFileHandle; name: string } | { kind: 'download'; name: string };

/**
 * Where the export goes: a file the user picks (needs a user gesture, so call it first) or a
 * download where File System Access is missing. Null when the user cancels.
 */
export async function chooseWavTarget(suggestedName: string): Promise<WavTarget | null> {
  const name = suggestedName.toLowerCase().endsWith('.wav') ? suggestedName : `${suggestedName}.wav`;
  if (!isFileSystemAccessSupported()) return { kind: 'download', name };
  const handle = await pickSaveWavFile(name);
  return handle ? { kind: 'file', handle, name: handle.name } : null;
}

export async function writeWav(target: WavTarget, bytes: Uint8Array): Promise<void> {
  if (target.kind === 'file') await writeFile(target.handle, bytes);
  else downloadBytes(target.name, bytes, 'audio/wav');
}
