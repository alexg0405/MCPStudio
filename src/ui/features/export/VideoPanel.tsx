import { useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useStore } from 'zustand';
import { planExport, planSeconds, type ExportRange } from '@app/export/plan';
import { videoSettingsFrom, workerSettings, type VideoExportSettings } from '@app/export/video/video-export';
import { NO_WEBCODECS, firstSupported, webCodecsAvailable } from '@app/export/video/support';
import type { PrefsState } from '@app/stores/prefs';
import { VIDEO_FORMAT_INFO, VIDEO_SAMPLE_RATE, videoDimensions, type VideoFormat } from '@core/video/formats';
import { useDoc, useServices, useView } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import { readTheme } from '../../timeline/canvas';
import { ExportFooter } from './ExportFooter';
import { formatTime, megabytes } from './export-text';
import { useCoverPicture, useFormatSupport, useVideoPreview } from './video-panel-hooks';
import { videoStageText } from './video-options';
import { videoThemeOf } from './video-preview';
import { useVideoExport } from './use-video-export';
import { VideoLookSection, VideoWordsSection } from './VideoSections';
import styles from './ExportDialog.module.css';

/** The preview frame is drawn at this fraction of the full video size. */
const PREVIEW_SCALE = 0.25;

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
  const projectName = useStore(services.files.store, (f) => f.name);
  const set = (patch: Partial<PrefsState>) => services.prefs.getState().set(patch);
  const [title, setTitle] = useState(() => project.meta.title?.trim() || projectName.replace(/\.agproj$/i, '') || 'Untitled');
  const [artist, setArtist] = useState(() => project.meta.author?.trim() ?? '');
  const cover = useCoverPicture();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const style = prefs.exportVideoStyle;
  const size = prefs.exportVideoSize;
  const fps: 30 | 60 = prefs.exportVideoFps === 60 ? 60 : 30;
  const isEncodingAvailable = webCodecsAvailable();
  const support = useFormatSupport(size, fps);
  const format: VideoFormat = (support && firstSupported(support, prefs.exportVideoFormat)) || prefs.exportVideoFormat;
  const isFormatSupported = !support || support[format] === null;
  const formatProblem = useMemo(
    () => (!isEncodingAvailable ? NO_WEBCODECS : support && support[format] ? support[format] : null),
    [isEncodingAvailable, support, format],
  );

  const previewSize = videoDimensions(size, PREVIEW_SCALE);
  useVideoPreview(canvasRef, { style, width: previewSize.width, height: previewSize.height, title, artist, image: cover.bitmap, theme: prefs.theme, accent: prefs.accent });

  const plan = planExport(project, view, range);
  const seconds = 'error' in plan ? 0 : planSeconds(project, plan);
  const fullSize = videoDimensions(size);
  const encoderSettings = workerSettings({ size, fps, format });
  const estimatedBytes = ((encoderSettings.videoBitrate + encoderSettings.info.audioBitrate) / 8) * seconds;

  const currentSettings = (): VideoExportSettings => ({
    ...videoSettingsFrom({ ...prefs, exportVideoFormat: format }, range, { title: title.trim() || 'Untitled', artist: artist.trim() }),
    image: cover.image,
    theme: videoThemeOf(readTheme()),
  });
  const videoExport = useVideoExport({ currentSettings, fileTitle: title.trim() || projectName, onBusy, abortRef, onClose });
  const isBusy = videoExport.progress !== null;

  return (
    <>
      {!isEncodingAvailable && <p className={styles.error}>{NO_WEBCODECS}</p>}
      <VideoLookSection
        style={style}
        size={size}
        fps={fps}
        format={format}
        support={support}
        isEncodingAvailable={isEncodingAvailable}
        formatProblem={formatProblem}
        canvasRef={canvasRef}
        previewWidth={previewSize.width}
        previewHeight={previewSize.height}
        set={set}
        isLocked={isBusy}
      />
      <VideoWordsSection
        title={title}
        artist={artist}
        onTitleChange={setTitle}
        onArtistChange={setArtist}
        image={cover.image}
        imageError={cover.imageError}
        onChooseImage={cover.choose}
        onRemoveImage={cover.clear}
        style={style}
        normalize={prefs.exportNormalize}
        set={set}
        isLocked={isBusy}
      />

      <p className={dialog.detail}>
        {'error' in plan
          ? plan.error
          : `${fullSize.width} × ${fullSize.height}, ${fps} fps, ${formatTime(seconds)} of music: about ${megabytes(estimatedBytes)}. The audio is rendered with the same engine as the audio export (${VIDEO_SAMPLE_RATE / 1000} kHz), then the pictures are drawn from it: no need to play the song.`}
      </p>
      <ExportFooter
        fraction={videoExport.progress?.fraction ?? null}
        stageText={videoExport.progress ? videoStageText(videoExport.progress) : ''}
        errorText={videoExport.error}
        startLabel="Export video…"
        startHint={`Choose where to save the ${VIDEO_FORMAT_INFO[format].ext.toUpperCase()} file, then the video is rendered and drawn`}
        canStart={!('error' in plan) && isEncodingAvailable && isFormatSupported}
        cancelHint="Close without exporting (Esc); stops a video that is being made"
        onStart={() => void videoExport.start()}
        onCancel={onClose}
      />
    </>
  );
}
