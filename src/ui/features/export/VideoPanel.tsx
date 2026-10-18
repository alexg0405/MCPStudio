import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useStore } from 'zustand';
import { ExportError, type ExportProgress } from '@app/export/export-wav';
import { planExport, planSeconds, type ExportRange } from '@app/export/plan';
import {
  chooseVideoTarget,
  runVideoExport,
  videoPrefsPatch,
  videoSettingsFrom,
  workerSettings,
  type VideoExportSettings,
} from '@app/export/video/video-export';
import {
  NO_WEBCODECS,
  firstSupported,
  probeFormats,
  webCodecsAvailable,
  type FormatSupport,
} from '@app/export/video/support';
import type { PrefsState } from '@app/stores/prefs';
import {
  VIDEO_FORMATS,
  VIDEO_FORMAT_INFO,
  VIDEO_SAMPLE_RATE,
  VIDEO_SIZES,
  VIDEO_STYLES,
  type VideoFormat,
  type VideoSize,
  type VideoStyle,
  videoDimensions,
} from '@core/video/formats';
import { useDoc, useServices, useView } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import { readTheme } from '../../timeline/canvas';
import styles from './ExportDialog.module.css';
import { drawPreview, videoThemeOf } from './video-preview';

const STYLE_INFO: Record<VideoStyle, { label: string; note: string }> = {
  bars: { label: 'Bars', note: 'Spectrum bars that jump with the music, with a reflection: the classic visualizer.' },
  wave: { label: 'Waveform', note: 'The sound as a glowing line that moves with every note.' },
  circle: { label: 'Circle', note: 'A ring of bars around your cover picture (or a glow when there is none).' },
  minimal: {
    label: 'Minimal',
    note: 'A big title, a progress bar with the time, and a ring that pulses on the beat. Calm and clean.',
  },
};

const SIZE_INFO: Record<VideoSize, { label: string; note: string }> = {
  '1080p': { label: 'Widescreen', note: '1920 × 1080: YouTube, websites and presentations.' },
  vertical: { label: 'Vertical', note: '1080 × 1920: shorts, reels, TikTok and stories.' },
  square: { label: 'Square', note: '1080 × 1080: Instagram and feed posts.' },
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "41 MB", "1.2 GB". */
function megabytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

interface Props {
  /** The range the dialog's Range section has chosen. */
  range: ExportRange;
  /** Tells the dialog an export is running (its tabs and range lock). */
  onBusy(busy: boolean): void;
  /** Shared with the dialog, so Esc and Cancel can stop the export. */
  abortRef: MutableRefObject<AbortController | null>;
  onClose(): void;
}

/**
 * The "Export as video" half of the Export dialog: look (style, shape, frame rate), file format, the text and
 * picture on it, and a preview of one frame drawn by the same code the export uses.
 */
export function VideoPanel({ range, onBusy, abortRef, onClose }: Props) {
  const services = useServices();
  const project = useDoc((p) => p);
  const view = useView((v) => v);
  const prefs = useStore(services.prefs);
  const name = useStore(services.files.store, (f) => f.name);
  const set = (patch: Partial<PrefsState>) => services.prefs.getState().set(patch);
  const [title, setTitle] = useState(() => project.meta.title?.trim() || name.replace(/\.agproj$/i, '') || 'Untitled');
  const [artist, setArtist] = useState(() => project.meta.author?.trim() ?? '');
  const [image, setImage] = useState<File | null>(null);
  const [decoded, setDecoded] = useState<{ file: File; bitmap: ImageBitmap } | null>(null);
  const bitmap = decoded && decoded.file === image ? decoded.bitmap : null;
  const [imageError, setImageError] = useState<string | null>(null);
  const [support, setSupport] = useState<FormatSupport | null>(null);
  const [progress, setProgress] = useState<(ExportProgress & { label?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const style = prefs.exportVideoStyle;
  const size = prefs.exportVideoSize;
  const fps: 30 | 60 = prefs.exportVideoFps === 60 ? 60 : 30;
  const available = webCodecsAvailable();

  // Which formats this browser can make at this size and frame rate.
  useEffect(() => {
    let live = true;
    void probeFormats(size, fps).then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [size, fps]);
  const format: VideoFormat = (support && firstSupported(support, prefs.exportVideoFormat)) || prefs.exportVideoFormat;
  const formatOk = !support || support[format] === null;

  // The cover picture, decoded for the preview (the export decodes it again when it starts).
  useEffect(() => {
    if (!image) return;
    let live = true;
    let made: ImageBitmap | null = null;
    createImageBitmap(image)
      .then((b) => {
        if (!live) return b.close();
        made = b;
        setDecoded({ file: image, bitmap: b });
        setImageError(null);
      })
      .catch(() => {
        if (!live) return;
        setImage(null);
        setImageError('That file is not a picture AGstudio can read. Choose a JPEG, PNG, WebP or GIF image.');
      });
    return () => {
      live = false;
      made?.close();
    };
  }, [image]);

  // The preview: one frame over example music, redrawn when anything about the look changes.
  const dims = videoDimensions(size, 0.25);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    try {
      drawPreview(c, {
        style,
        width: dims.width,
        height: dims.height,
        title,
        artist,
        theme: videoThemeOf(readTheme()),
        image: bitmap,
      });
    } catch (e) {
      console.warn('Video preview failed', e);
    }
  }, [style, dims.width, dims.height, title, artist, bitmap, prefs.theme, prefs.accent]);

  const plan = planExport(project, view, range);
  const seconds = 'error' in plan ? 0 : planSeconds(project, plan);
  const full = videoDimensions(size);
  const sized = workerSettings({ size, fps, format });
  const estimate = ((sized.videoBitrate + sized.info.audioBitrate) / 8) * seconds;

  const settings = (): VideoExportSettings => ({
    ...videoSettingsFrom({ ...prefs, exportVideoFormat: format }, range, {
      title: title.trim() || 'Untitled',
      artist: artist.trim(),
    }),
    image,
    theme: videoThemeOf(readTheme()),
  });

  const start = async () => {
    setError(null);
    const s = settings();
    let target;
    try {
      // The click on Export is the user gesture the save dialog needs, so ask first.
      target = await chooseVideoTarget(title.trim() || name, s.format);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!target) return;
    set(videoPrefsPatch(s));
    const controller = new AbortController();
    abortRef.current = controller;
    onBusy(true);
    setProgress({ stage: 'render', fraction: 0 });
    try {
      const res = await runVideoExport(services, s, target, { signal: controller.signal, onProgress: setProgress });
      services.session
        .getState()
        .toast(
          `Exported “${target.name}” (${formatTime(res.seconds)}, ${megabytes(res.bytes)}, made in ${formatTime(res.took)})`,
        );
      onClose();
    } catch (e) {
      if (controller.signal.aborted) {
        services.session.getState().toast('Export cancelled');
        onClose();
        return;
      }
      console.error('Video export failed', e);
      setError(e instanceof ExportError || e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      onBusy(false);
      setProgress(null);
    }
  };

  const busy = progress !== null;
  const stage = progress?.label
    ? `Working on ${progress.label}`
    : progress?.stage === 'encode'
      ? 'Drawing and encoding the video'
      : 'Rendering the audio';
  const formatInfo = VIDEO_FORMAT_INFO[format];
  const reason = useMemo(
    () => (!available ? NO_WEBCODECS : support && support[format] ? support[format] : null),
    [available, support, format],
  );

  return (
    <>
      {!available && <p className={styles.error}>{NO_WEBCODECS}</p>}
      <fieldset className={styles.group} disabled={busy}>
        <legend>Look</legend>
        <div className={styles.videoLook}>
          <div className={styles.videoControls}>
            <div className={styles.segmented} role="radiogroup" aria-label="Picture style">
              {VIDEO_STYLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={style === v}
                  className={`${styles.segment} ${style === v ? styles.segmentOn : ''}`}
                  onClick={() => set({ exportVideoStyle: v })}
                  data-hint={`${STYLE_INFO[v].label}: ${STYLE_INFO[v].note}`}
                >
                  {STYLE_INFO[v].label}
                </button>
              ))}
            </div>
            <p className={styles.note}>{STYLE_INFO[style].note}</p>
            <div className={styles.segmented} role="radiogroup" aria-label="Picture shape">
              {VIDEO_SIZES.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={size === v}
                  className={`${styles.segment} ${size === v ? styles.segmentOn : ''}`}
                  onClick={() => set({ exportVideoSize: v })}
                  data-hint={`${SIZE_INFO[v].label}, ${SIZE_INFO[v].note}`}
                >
                  {SIZE_INFO[v].label}
                </button>
              ))}
            </div>
            <p className={styles.note}>{SIZE_INFO[size].note}</p>
          </div>
          <div
            className={styles.previewBox}
            data-hint="One frame of the video, drawn over a few seconds of example music (your song is rendered when you export)"
          >
            <canvas
              ref={canvas}
              className={styles.preview}
              style={{ aspectRatio: `${dims.width} / ${dims.height}` }}
              aria-label="Preview of one frame of the video"
            />
            <span className={styles.previewLabel}>Preview, with example sound</span>
          </div>
        </div>
        <div className={styles.row}>
          <label
            className={styles.field}
            data-hint="Pictures per second: 30 makes smaller files and is smooth enough for music; 60 is smoother but bigger and slower to make"
          >
            Frame rate
            <select value={fps} onChange={(e) => set({ exportVideoFps: Number(e.target.value) })}>
              <option value={30}>30 frames per second</option>
              <option value={60}>60 frames per second (smoother)</option>
            </select>
          </label>
          <label
            className={styles.field}
            data-hint="The file type and codec: MP4 plays everywhere (phones, social apps); WebM is open and plays in browsers and YouTube; AV1 makes the smallest files but is slow"
          >
            File format
            <select value={format} onChange={(e) => set({ exportVideoFormat: e.target.value as VideoFormat })}>
              {VIDEO_FORMATS.map((f) => {
                const why = support?.[f] ?? (available ? null : NO_WEBCODECS);
                return (
                  <option key={f} value={f} disabled={!!why} title={why ?? VIDEO_FORMAT_INFO[f].note}>
                    {VIDEO_FORMAT_INFO[f].label}
                    {why ? ' (not available here)' : ''}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
        <p className={styles.note}>{reason ?? formatInfo.note}</p>
      </fieldset>

      <fieldset className={styles.group} disabled={busy}>
        <legend>Words and picture</legend>
        <div className={styles.row}>
          <label className={styles.field} data-hint="The big text on the video: usually the song's name">
            Title
            <input
              className={styles.text}
              type="text"
              value={title}
              maxLength={120}
              placeholder="Song title"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label
            className={styles.field}
            data-hint="Smaller text under the title: your name or the project's artist (leave empty for none)"
          >
            Artist
            <input
              className={styles.text}
              type="text"
              value={artist}
              maxLength={120}
              placeholder="Artist (optional)"
              onChange={(e) => setArtist(e.target.value)}
            />
          </label>
        </div>
        <div className={styles.row}>
          <button
            type="button"
            className={dialog.button}
            onClick={() => picker.current?.click()}
            data-hint="Choose a cover picture or background (JPEG, PNG, WebP, GIF). It is used only for this export and is not saved in your project"
          >
            {image ? 'Change picture…' : 'Choose picture…'}
          </button>
          {image && (
            <button
              type="button"
              className={dialog.button}
              onClick={() => setImage(null)}
              data-hint="Go back to the plain background"
            >
              Remove picture
            </button>
          )}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) {
                setImageError(null);
                setImage(f);
              }
            }}
          />
        </div>
        <p className={styles.note}>
          {image
            ? `Using “${image.name}” as the background${style === 'circle' ? ' and in the middle of the ring' : ''}. It is only used for this video.`
            : 'Optional: a cover picture or background. It is dimmed so the bars stay easy to see.'}
        </p>
        {imageError && <p className={styles.error}>{imageError}</p>}
        <label
          className={styles.option}
          data-hint="Turns the whole video's sound up (or down) so its loudest moment peaks at −0.3 dBFS, just under the maximum"
        >
          <input
            type="checkbox"
            checked={prefs.exportNormalize}
            onChange={(e) => set({ exportNormalize: e.target.checked })}
          />
          <span>Normalize: make the loudest moment peak at −0.3 dB</span>
        </label>
      </fieldset>

      <p className={dialog.detail}>
        {'error' in plan
          ? plan.error
          : `${full.width} × ${full.height}, ${fps} fps, ${formatTime(seconds)} of music: about ${megabytes(estimate)}. The audio is rendered with the same engine as the audio export (${VIDEO_SAMPLE_RATE / 1000} kHz), then the pictures are drawn from it: no need to play the song.`}
      </p>
      {busy && (
        <div className={styles.progress} role="progressbar" aria-valuenow={Math.round(progress.fraction * 100)}>
          <div className={styles.bar} style={{ width: `${progress.fraction * 100}%` }} />
          <span>
            {stage}… {Math.round(progress.fraction * 100)}%
          </span>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      <div className={dialog.buttons}>
        <button
          className={dialog.button}
          onClick={onClose}
          data-hint="Close without exporting (Esc); stops a video that is being made"
        >
          Cancel
        </button>
        {!busy && (
          <button
            className={`${dialog.button} ${dialog.primary}`}
            disabled={'error' in plan || !available || !formatOk}
            onClick={() => void start()}
            data-hint={`Choose where to save the ${formatInfo.ext.toUpperCase()} file, then the video is rendered and drawn`}
          >
            Export video…
          </button>
        )}
      </div>
    </>
  );
}
