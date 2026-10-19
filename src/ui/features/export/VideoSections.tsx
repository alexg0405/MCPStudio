import { useRef, type RefObject } from 'react';
import { NO_WEBCODECS, type FormatSupport } from '@app/export/video/support';
import type { PrefsState } from '@app/stores/prefs';
import { VIDEO_FORMATS, VIDEO_FORMAT_INFO, VIDEO_SIZES, VIDEO_STYLES, type VideoFormat, type VideoSize, type VideoStyle } from '@core/video/formats';
import dialog from '../../controls/Dialog.module.css';
import styles from './ExportDialog.module.css';
import { SIZE_INFO, STYLE_INFO } from './video-options';

/** Writes some of the export settings (they live in the prefs). */
type SetPrefs = (patch: Partial<PrefsState>) => void;

interface VideoLookSectionProps {
  style: VideoStyle;
  size: VideoSize;
  fps: 30 | 60;
  format: VideoFormat;
  /** Which formats this browser can make (null until checked), and whether it has video encoding at all. */
  support: FormatSupport | null;
  isEncodingAvailable: boolean;
  /** Why the chosen format cannot be made, or null when it can. */
  formatProblem: string | null;
  /** The preview canvas, and its size in pixels. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  previewWidth: number;
  previewHeight: number;
  set: SetPrefs;
  isLocked: boolean;
}

/** The "Look" fieldset: picture style and shape, a preview frame, the frame rate and the file format. */
export function VideoLookSection(props: VideoLookSectionProps) {
  const { style, size, fps, format, support, isEncodingAvailable, formatProblem, canvasRef, previewWidth, previewHeight, set, isLocked } = props;
  return (
    <fieldset className={styles.group} disabled={isLocked}>
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
        <div className={styles.previewBox} data-hint="One frame of the video, drawn over a few seconds of example music (your song is rendered when you export)">
          <canvas ref={canvasRef} className={styles.preview} style={{ aspectRatio: `${previewWidth} / ${previewHeight}` }} aria-label="Preview of one frame of the video" />
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
              const why = support?.[f] ?? (isEncodingAvailable ? null : NO_WEBCODECS);
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
      <p className={styles.note}>{formatProblem ?? VIDEO_FORMAT_INFO[format].note}</p>
    </fieldset>
  );
}

interface VideoWordsSectionProps {
  title: string;
  artist: string;
  onTitleChange(text: string): void;
  onArtistChange(text: string): void;
  /** The cover picture chosen, if any, and why the last one could not be used. */
  image: File | null;
  imageError: string | null;
  onChooseImage(file: File): void;
  onRemoveImage(): void;
  style: VideoStyle;
  normalize: boolean;
  set: SetPrefs;
  isLocked: boolean;
}

/** The "Words and picture" fieldset: title, artist, an optional cover picture and normalize. */
export function VideoWordsSection(props: VideoWordsSectionProps) {
  const { title, artist, onTitleChange, onArtistChange, image, imageError, onChooseImage, onRemoveImage, style, normalize, set, isLocked } = props;
  const pickerRef = useRef<HTMLInputElement>(null);
  const pictureNote = image
    ? `Using “${image.name}” as the background${style === 'circle' ? ' and in the middle of the ring' : ''}. It is only used for this video.`
    : 'Optional: a cover picture or background. It is dimmed so the bars stay easy to see.';
  return (
    <fieldset className={styles.group} disabled={isLocked}>
      <legend>Words and picture</legend>
      <div className={styles.row}>
        <label className={styles.field} data-hint="The big text on the video: usually the song's name">
          Title
          <input className={styles.text} type="text" value={title} maxLength={120} placeholder="Song title" onChange={(e) => onTitleChange(e.target.value)} />
        </label>
        <label className={styles.field} data-hint="Smaller text under the title: your name or the project's artist (leave empty for none)">
          Artist
          <input className={styles.text} type="text" value={artist} maxLength={120} placeholder="Artist (optional)" onChange={(e) => onArtistChange(e.target.value)} />
        </label>
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={dialog.button}
          onClick={() => pickerRef.current?.click()}
          data-hint="Choose a cover picture or background (JPEG, PNG, WebP, GIF). It is used only for this export and is not saved in your project"
        >
          {image ? 'Change picture…' : 'Choose picture…'}
        </button>
        {image && (
          <button type="button" className={dialog.button} onClick={onRemoveImage} data-hint="Go back to the plain background">
            Remove picture
          </button>
        )}
        <input
          ref={pickerRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onChooseImage(file);
          }}
        />
      </div>
      <p className={styles.note}>{pictureNote}</p>
      {imageError && <p className={styles.error}>{imageError}</p>}
      <label className={styles.option} data-hint="Turns the whole video's sound up (or down) so its loudest moment peaks at −0.3 dBFS, just under the maximum">
        <input type="checkbox" checked={normalize} onChange={(e) => set({ exportNormalize: e.target.checked })} />
        <span>Normalize: make the loudest moment peak at −0.3 dB</span>
      </label>
    </fieldset>
  );
}
