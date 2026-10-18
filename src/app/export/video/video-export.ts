/**
 * Export as video: the song (or a range: a section, the loop, a clip's bars) as a music video file,
 * made offline. The audio is rendered through the same path as the audio export (same ranges, same
 * normalize, same trimming), and while it comes in, a Worker draws one picture per video frame from the
 * rendered sound (spectrum, waveform, beat pulse), encodes pictures and sound with WebCodecs, muxes them
 * (WebM or MP4) and streams the file out: a long song is never held whole, and nothing depends on playing
 * the song in real time.
 */
import { normalizeGain } from '@core/audio/envelope';
import { tempoMapOf } from '@core/automation/tempo';
import type { Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { beatGrid } from '@core/video/beats';
import {
  KEYFRAME_SECONDS,
  VIDEO_FORMAT_INFO,
  VIDEO_SAMPLE_RATE,
  videoBitrate,
  videoDimensions,
  type VideoFormat,
  type VideoSize,
  type VideoStyle,
} from '@core/video/formats';
import { measureTail } from '@engine/render-offline';
import { isFileSystemAccessSupported, pickSaveExportFile } from '@platform/fs-access';
import type { PrefsState } from '../../stores/prefs';
import type { Services } from '../../services';
import { whileBusy } from '../../storage/busy';
import { sinkFor, type ExportHooks, type ExportTarget } from '../audio-export';
import { ExportError } from '../export-wav';
import { planExport, planSeconds, type ExportRange } from '../plan';
import { renderPass } from '../render-pass';
import { DEFAULT_VIDEO_THEME, type VideoTheme } from './frames';
import { NO_WEBCODECS, webCodecsAvailable } from './support';
import { openVideoSession, VideoEncodeError, type VideoSession } from './video-session';

export interface VideoExportSettings {
  range: ExportRange;
  style: VideoStyle;
  size: VideoSize;
  fps: 30 | 60;
  format: VideoFormat;
  /** Big text on the picture (the song's name). */
  title: string;
  /** Smaller text under it (the artist). */
  artist: string;
  /** Raise the whole export so its loudest moment peaks at −0.3 dBFS, as in the audio export. */
  normalize: boolean;
  /** A picture to put behind everything (or in the middle of the circle): kept only for this export. */
  image?: Blob | null | undefined;
  /** Draw at this share of the full size (tests and previews; the dialog never sets it). */
  scale?: number | undefined;
  /** Colours of the picture; the app's own theme when left out. */
  theme?: VideoTheme | undefined;
}

/** The video settings remembered in the prefs, for a range; the text is the song's. */
export function videoSettingsFrom(
  p: PrefsState,
  range: ExportRange,
  text: { title: string; artist: string },
): VideoExportSettings {
  return {
    range,
    style: p.exportVideoStyle,
    size: p.exportVideoSize,
    fps: p.exportVideoFps === 60 ? 60 : 30,
    format: p.exportVideoFormat,
    title: text.title,
    artist: text.artist,
    normalize: p.exportNormalize,
  };
}

/** The prefs that remember a video export's choices. */
export function videoPrefsPatch(
  v: Pick<VideoExportSettings, 'style' | 'size' | 'fps' | 'format' | 'normalize'>,
): Partial<PrefsState> {
  return {
    exportVideoStyle: v.style,
    exportVideoSize: v.size,
    exportVideoFps: v.fps,
    exportVideoFormat: v.format,
    exportNormalize: v.normalize,
  };
}

/** "My song.mp4": the project's name with the format's extension. */
export function videoFileName(base: string, format: VideoFormat): string {
  const clean = base.replace(/\.(agproj|wav|flac|mp3|zip|mp4|webm)$/i, '').trim() || 'Untitled';
  return `${clean}.${VIDEO_FORMAT_INFO[format].ext}`;
}

/**
 * Asks where the video goes (a save dialog; it needs the click's user gesture, so call it first). Null when
 * the user cancels. Without File System Access the video is collected in memory and downloaded at the end.
 */
export async function chooseVideoTarget(base: string, format: VideoFormat): Promise<ExportTarget | null> {
  const name = videoFileName(base, format);
  if (!isFileSystemAccessSupported()) return { kind: 'download', name };
  const handle = await pickSaveExportFile(name, VIDEO_FORMAT_INFO[format].ext);
  return handle ? { kind: 'file', handle, name: handle.name } : null;
}

let themeProvider: (() => VideoTheme) | null = null;

/** The UI tells the export where to read the app's colours (the export lives below the UI and cannot import it). */
export function setVideoThemeProvider(fn: (() => VideoTheme) | null): void {
  themeProvider = fn;
}

/** The colours a video made now would use. */
export function currentVideoTheme(): VideoTheme {
  try {
    return themeProvider?.() ?? DEFAULT_VIDEO_THEME;
  } catch {
    return DEFAULT_VIDEO_THEME;
  }
}

export interface VideoExportResult {
  name: string;
  /** Seconds of video written. */
  seconds: number;
  frames: number;
  bytes: number;
  /** Wall-clock seconds the export took. */
  took: number;
}

const MUSIC_AUDIO_RATE = VIDEO_SAMPLE_RATE;

/** What the codec needs to start, from settings. */
export function workerSettings(settings: Pick<VideoExportSettings, 'format' | 'size' | 'fps' | 'scale'>) {
  const info = VIDEO_FORMAT_INFO[settings.format];
  const { width, height } = videoDimensions(settings.size, settings.scale ?? 1);
  return {
    info,
    width,
    height,
    videoCodec: info.videoCodec(settings.fps),
    videoBitrate: videoBitrate(settings.format, width, height, settings.fps),
  };
}

/**
 * Renders and writes the video: audio through the export's render, a picture per frame drawn and encoded
 * in a Worker, the file streamed into the target. Rejects with ExportError (or an AbortError).
 */
export function runVideoExport(
  s: Services,
  settings: VideoExportSettings,
  target: ExportTarget,
  hooks: ExportHooks = {},
): Promise<VideoExportResult> {
  // The project as it is now keeps all its audio until the export is done, even if a sample is deleted meanwhile.
  return whileBusy(() => runVideoExportOf(s, s.doc.getState().project, settings, target, hooks), {
    project: s.doc.getState().project,
  });
}

async function runVideoExportOf(
  s: Services,
  project: Project,
  settings: VideoExportSettings,
  target: ExportTarget,
  hooks: ExportHooks,
): Promise<VideoExportResult> {
  if (!webCodecsAvailable()) throw new ExportError(NO_WEBCODECS);
  const started = performance.now();
  const plan = planExport(project, s.view.getState(), settings.range);
  if ('error' in plan) throw new ExportError(plan.error);
  s.engine.stop();
  const signal = hooks.signal;
  const rate = MUSIC_AUDIO_RATE;
  const musical = planSeconds(project, plan);
  const musicFrames = Math.ceil(musical * rate);
  const { info, width, height, videoCodec, videoBitrate: vbr } = workerSettings(settings);
  const tail = await measureTail(project, { plugins: s.plugins, sampleCache: s.sampleCache }, rate);
  signal?.throwIfAborted();

  // The beat grid of the range, from the same tempo map the render follows.
  const tempo = tempoMapOf(project, plan.mode);
  const ts = project.transport.timeSig;
  const toTick = plan.fromTick + plan.bars * ticksPerBar(ts);
  const beats = beatGrid(tempo, ts, plan.fromTick, toTick);

  const steps = settings.normalize ? 2 : 1;
  const report = (step: number, fraction: number, stage: 'render' | 'encode', label: string) =>
    hooks.onProgress?.({ stage, fraction: Math.min(0.99, (step + fraction) / steps), label });

  // Normalize: a first render that only finds the peak.
  let gain = 1;
  let length: number | undefined;
  if (settings.normalize) {
    let peak = 0;
    length = await renderPass(
      {
        s,
        project,
        plan,
        sampleRate: rate,
        tail,
        musicFrames,
        limiter: true,
        signal,
        onRender: (f) => report(0, f, 'render', 'the audio (to find its level)'),
      },
      async (piece) => {
        for (const c of piece) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i] as number));
      },
    );
    gain = normalizeGain(peak);
  }

  const image = settings.image ? await createImageBitmap(settings.image).catch(() => null) : null;
  if (settings.image && !image)
    throw new ExportError('That picture could not be read. Choose a JPEG, PNG, WebP or GIF image.');
  const { sink, done } = await sinkFor(target, info.mime);
  let session: VideoSession | null = null;
  try {
    session = await openVideoSession(
      {
        format: settings.format,
        videoCodec,
        audioCodec: info.audioCodec,
        width,
        height,
        fps: settings.fps,
        videoBitrate: vbr,
        audioBitrate: info.audioBitrate,
        sampleRate: rate,
        style: settings.style,
        theme: settings.theme ?? currentVideoTheme(),
        title: settings.title,
        artist: settings.artist,
        beatTimes: beats.times,
        beatStrong: beats.strong,
        seconds: musical,
        keyframeSeconds: KEYFRAME_SECONDS,
      },
      sink,
      image,
    );
    const first = settings.normalize ? 1 : 0;
    let delivered = 0;
    let renderFraction = 0;
    // The render (fast) and the pictures (slower) share the bar: a tenth for the render, the rest for the video.
    const show = () =>
      report(
        first,
        0.1 * renderFraction + 0.9 * Math.min(1, delivered / Math.max(1, musical * rate)),
        delivered > 0 ? 'encode' : 'render',
        delivered > 0 ? 'the video' : 'the audio',
      );
    const sent = session;
    await renderPass(
      {
        s,
        project,
        plan,
        sampleRate: rate,
        tail,
        musicFrames,
        limiter: true,
        length,
        signal,
        onRender: (f) => {
          renderFraction = f;
          show();
        },
      },
      async (piece) => {
        // The render's arrays are ours: scaled in place, then handed to the Worker.
        const own = piece.map((c) => (c.byteOffset === 0 && c.length === c.buffer.byteLength / 4 ? c : c.slice()));
        if (gain !== 1) for (const c of own) for (let i = 0; i < c.length; i++) c[i] = (c[i] as number) * gain;
        const n = own[0]?.length ?? 0;
        await sent.push(own);
        delivered += n;
        show();
      },
    );
    signal?.throwIfAborted();
    hooks.onProgress?.({ stage: 'encode', fraction: 0.99, label: 'finishing the file' });
    const r = await session.finish();
    await done();
    hooks.onProgress?.({ stage: 'encode', fraction: 1 });
    return {
      name: target.name,
      seconds: r.seconds,
      frames: r.frames,
      bytes: r.bytes,
      took: (performance.now() - started) / 1000,
    };
  } catch (e) {
    session?.close();
    await sink.abort();
    if (e instanceof VideoEncodeError && !signal?.aborted) throw new ExportError(e.message);
    throw e;
  } finally {
    image?.close();
  }
}
