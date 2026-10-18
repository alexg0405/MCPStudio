/**
 * The tools that render: a mix analysis, a short WAV preview an AI app can hear, and an export that
 * the dev server writes into the Music folder (no file dialog). Heavy dependencies are injectable so
 * the unit tests (Node has no OfflineAudioContext) can stand in for them.
 */
import { encodeWav } from '@core/io/wav';
import type { Project } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { analysisPlan, analyzeMix, formatMixReport, summarizeMixReport } from '../analysis/mix';
import {
  exportFileName,
  exportSettingsFrom,
  runExport,
  type AudioExportSettings,
  type ExportTarget,
} from '../export/audio-export';
import { ExportError, trimExport } from '../export/export-wav';
import {
  runVideoExport,
  videoFileName,
  videoSettingsFrom,
  type VideoExportSettings,
} from '../export/video/video-export';
import { VIDEO_FORMATS, VIDEO_SIZES, VIDEO_STYLES } from '@core/video/formats';
import { planExport, planSeconds, type ExportRange } from '../export/plan';
import type { Services } from '../services';
import { barsArg, fail, ok, str, toBase64, type ToolFn } from './common';

const PREVIEW_RATE = 32000;
/** An export is held in memory until it is uploaded: longer songs go through the Export dialog. */
const MAX_EXPORT_SECONDS = 20 * 60;
/** A video is far bigger than its audio (tens of megabytes a minute): longer ones go through the Export dialog. */
const MAX_VIDEO_SECONDS = 4 * 60;

export interface AudioDeps {
  analyze: typeof analyzeMix;
  /** Renders the part and returns a WAV (Node tests pass a fake). */
  preview(s: Services, bars: { from: number; to: number } | undefined, maxSeconds: number): Promise<{ wav: Uint8Array; seconds: number; what: string }>;
  exportAudio: typeof runExport;
  exportVideo: typeof runVideoExport;
  /** Sends a rendered file to the dev server (it writes it under the Music folder); returns its path. */
  upload(ticket: string, file: { name: string; folder?: string; bytes: Uint8Array }): Promise<string>;
}

const ticksOf = (p: Project, bars: { from: number; to: number }) => {
  const bar = ticksPerBar(p.transport.timeSig);
  return { from: (bars.from - 1) * bar, to: bars.to * bar };
};

export async function renderPreview(
  s: Services,
  bars: { from: number; to: number } | undefined,
  maxSeconds: number,
): Promise<{ wav: Uint8Array; seconds: number; what: string }> {
  const project = s.doc.getState().project;
  const plan = analysisPlan(s, maxSeconds, bars ? ticksOf(project, bars) : undefined);
  const seconds = planSeconds(project, plan);
  s.engine.stop();
  const r = await renderOffline(project, {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: plan.mode, patternId: plan.patternId, loop: null },
    bars: plan.bars,
    fromTick: plan.fromTick,
    sampleRate: PREVIEW_RATE,
    tail: 0.5,
    limiter: true,
  });
  const channels = trimExport(r, seconds);
  const ts = project.transport.timeSig;
  const what =
    plan.mode === 'pattern'
      ? `the current pattern on a loop`
      : barSpan(plan.fromTick, plan.fromTick + plan.bars * ticksPerBar(ts), ts);
  return { wav: encodeWav(channels, PREVIEW_RATE, { bitDepth: 16, dither: true }), seconds: Math.round(seconds * 10) / 10, what };
}

export function uploadViaServer(fetchImpl: typeof fetch = (...a) => fetch(...a)): AudioDeps['upload'] {
  return async (ticket, file) => {
    const res = await fetchImpl(`/api/mcp/upload/${encodeURIComponent(ticket)}`, {
      method: 'POST',
      headers: {
        'x-agstudio': '1',
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
        ...(file.folder ? { 'x-folder': encodeURIComponent(file.folder) } : {}),
      },
      body: file.bytes as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`The dev server refused the file (${res.status}): ${(await res.text()).trim()}`);
    return ((await res.json()) as { path: string }).path;
  };
}

export function audioTools(deps: AudioDeps): Record<string, ToolFn> {
  const analyze_mix: ToolFn = async (s, args) => {
    const bars = barsArg(args.bars);
    if (typeof bars === 'string') return fail(bars);
    const project = s.doc.getState().project;
    try {
      const report = await deps.analyze(s, bars ? { range: ticksOf(project, bars) } : {});
      return ok(
        `Listened to ${report.what}.\n${summarizeMixReport(report)}\n\n${formatMixReport(report)}`,
        { what: report.what, seconds: report.seconds, findings: report.notes },
      );
    } catch (e) {
      return fail(`Could not listen to the mix: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const render_preview: ToolFn = async (s, args) => {
    const bars = barsArg(args.bars);
    if (typeof bars === 'string') return fail(bars);
    const max = typeof args.max_seconds === 'number' ? Math.min(30, Math.max(1, args.max_seconds)) : 15;
    try {
      const out = await deps.preview(s, bars, max);
      return {
        content: [
          { type: 'text', text: `Rendered ${out.what}: ${out.seconds} s of audio (32 kHz, 16-bit stereo WAV).` },
          { type: 'audio', data: toBase64(out.wav), mimeType: 'audio/wav' },
        ],
        structuredContent: { what: out.what, seconds: out.seconds, mimeType: 'audio/wav', bytes: out.wav.length },
      };
    } catch (e) {
      return fail(`Could not render a preview: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const export_audio: ToolFn = async (s, args, ctx) => {
    if (!ctx.ticket) return fail('Exporting needs the AGstudio dev server (it writes the file).');
    const bars = barsArg(args.bars);
    if (typeof bars === 'string') return fail(bars);
    const project = s.doc.getState().project;
    const range: ExportRange = bars ? ticksOf(project, bars) : songLength(project) > 0 ? 'song' : 'pattern';
    const plan = planExport(project, s.view.getState(), range);
    if ('error' in plan) return fail(plan.error);
    const seconds = planSeconds(project, plan);
    if (seconds > MAX_EXPORT_SECONDS)
      return fail(`That is ${Math.round(seconds / 60)} minutes of audio: too long to export from here. Use File → Export audio in AGstudio, or export a part with "bars".`);
    const base = exportSettingsFrom(s.prefs.getState(), range);
    const format = args.format === 'wav' || args.format === 'flac' || args.format === 'mp3' ? args.format : base.codec;
    const stems = args.stems === true;
    const settings: AudioExportSettings = {
      ...base,
      range,
      codec: format,
      stems,
      masterChain: true,
      stemsTo: 'folder',
      normalize: typeof args.normalize === 'boolean' ? args.normalize : base.normalize,
    };
    const name = str(args.file_name) ?? s.files.store.getState().name;
    const files = new Map<string, Uint8Array>();
    const target: ExportTarget = { kind: 'memory', files, name: exportFileName(name, settings.codec) };
    try {
      await deps.exportAudio(s, settings, target);
      const paths: string[] = [];
      for (const [file, bytes] of files)
        paths.push(await deps.upload(ctx.ticket, { name: file, ...(stems ? { folder: `${name} (stems)` } : {}), bytes }));
      if (paths.length === 0) return fail('Nothing was rendered.');
      const where = stems ? paths[0]!.replace(/[/\\][^/\\]*$/, '') : paths[0]!;
      return ok(
        stems
          ? `Exported ${paths.length} stems (${Math.round(seconds)} s each) to the folder ${where}.`
          : `Exported ${Math.round(seconds)} s of audio to ${where}.`,
        { files: paths, seconds: Math.round(seconds * 10) / 10, format: settings.codec },
      );
    } catch (e) {
      if (e instanceof ExportError) return fail(e.message);
      return fail(`The export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const export_video: ToolFn = async (s, args, ctx) => {
    if (!ctx.ticket) return fail('Exporting needs the AGstudio dev server (it writes the file).');
    const bars = barsArg(args.bars);
    if (typeof bars === 'string') return fail(bars);
    const project = s.doc.getState().project;
    const range: ExportRange = bars ? ticksOf(project, bars) : songLength(project) > 0 ? 'song' : 'pattern';
    const plan = planExport(project, s.view.getState(), range);
    if ('error' in plan) return fail(plan.error);
    const seconds = planSeconds(project, plan);
    if (seconds > MAX_VIDEO_SECONDS)
      return fail(`That is ${Math.round(seconds / 60)} minutes of music: too long to make a video from here (the file is held in memory). Use File → Export as video in AGstudio, or make a part with "bars".`);
    const pick = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (all as readonly string[]).includes(v as string) ? (v as T) : fallback;
    const base = videoSettingsFrom(s.prefs.getState(), range, {
      title: str(args.title) ?? (project.meta.title?.trim() || s.files.store.getState().name.replace(/\.agproj$/i, '') || 'Untitled'),
      artist: str(args.artist) ?? project.meta.author?.trim() ?? '',
    });
    const settings: VideoExportSettings = {
      ...base,
      style: pick(args.style, VIDEO_STYLES, base.style),
      size: pick(args.size, VIDEO_SIZES, base.size),
      fps: args.fps === 30 || args.fps === 60 ? args.fps : base.fps,
      format: pick(args.format, VIDEO_FORMATS, base.format),
      normalize: typeof args.normalize === 'boolean' ? args.normalize : base.normalize,
    };
    const name = str(args.file_name) ?? s.files.store.getState().name;
    const files = new Map<string, Uint8Array>();
    const target: ExportTarget = { kind: 'memory', files, name: videoFileName(name, settings.format) };
    try {
      const res = await deps.exportVideo(s, settings, target);
      const bytes = files.get(target.name);
      if (!bytes) return fail('Nothing was rendered.');
      const path = await deps.upload(ctx.ticket, { name: target.name, bytes });
      return ok(
        `Made a ${settings.size === 'vertical' ? 'vertical' : settings.size === 'square' ? 'square' : 'widescreen'} ${settings.style} video of ${Math.round(res.seconds)} s (${Math.round(bytes.length / 1e5) / 10} MB, ${settings.format}) at ${path}.`,
        { files: [path], seconds: Math.round(res.seconds * 10) / 10, bytes: bytes.length, format: settings.format, style: settings.style, size: settings.size, fps: settings.fps },
      );
    } catch (e) {
      if (e instanceof ExportError) return fail(e.message);
      return fail(`The video export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return { analyze_mix, render_preview, export_audio, export_video };
}

export const defaultAudioDeps = (): AudioDeps => ({
  analyze: analyzeMix,
  preview: renderPreview,
  exportAudio: runExport,
  exportVideo: runVideoExport,
  upload: uploadViaServer(),
});
