/** The words for the video export's looks: what each picture style and shape is and where it fits (pure). */
import type { VideoSize, VideoStyle } from '@core/video/formats';

/** The picture styles: a short name and a sentence about how it looks. */
export const STYLE_INFO: Record<VideoStyle, { label: string; note: string }> = {
  bars: { label: 'Bars', note: 'Spectrum bars that jump with the music, with a reflection: the classic visualizer.' },
  wave: { label: 'Waveform', note: 'The sound as a glowing line that moves with every note.' },
  circle: { label: 'Circle', note: 'A ring of bars around your cover picture (or a glow when there is none).' },
  minimal: {
    label: 'Minimal',
    note: 'A big title, a progress bar with the time, and a ring that pulses on the beat. Calm and clean.',
  },
};

/** The picture shapes: a short name and the size with the places it suits. */
export const SIZE_INFO: Record<VideoSize, { label: string; note: string }> = {
  '1080p': { label: 'Widescreen', note: '1920 × 1080: YouTube, websites and presentations.' },
  vertical: { label: 'Vertical', note: '1080 × 1920: shorts, reels, TikTok and stories.' },
  square: { label: 'Square', note: '1080 × 1080: Instagram and feed posts.' },
};

/** What the progress bar says while the video is made. */
export function videoStageText(progress: { stage: string; label?: string }): string {
  if (progress.label) return `Working on ${progress.label}`;
  if (progress.stage === 'encode') return 'Drawing and encoding the video';
  return 'Rendering the audio';
}
