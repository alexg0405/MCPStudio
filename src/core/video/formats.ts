/**
 * The choices of "Export as video": picture styles, sizes, frame rates and file formats, with the
 * codec strings and bit rates each one needs. Pure data and arithmetic (no DOM): the export, the
 * dialog, the AI command and the tests all read it from here.
 */

/** What the picture shows. */
export type VideoStyle = 'bars' | 'wave' | 'circle' | 'minimal';
/** Every `VideoStyle`, for lists and for checking loose input. */
export const VIDEO_STYLES: readonly VideoStyle[] = ['bars', 'wave', 'circle', 'minimal'];

/** The shape of the picture: widescreen, tall (shorts, reels, TikTok) or square. */
export type VideoSize = '1080p' | 'vertical' | 'square';
/** Every `VideoSize`, for lists and for checking loose input. */
export const VIDEO_SIZES: readonly VideoSize[] = ['1080p', 'vertical', 'square'];

/** The frame rates the video export offers, in frames per second. */
export const VIDEO_FPS: readonly (30 | 60)[] = [30, 60];

/** A picture size in pixels. */
export interface VideoDimensions {
  width: number;
  height: number;
}

/** Pixels of each size at full scale. The short side is always 1080. */
export const VIDEO_DIMENSIONS: Readonly<Record<VideoSize, VideoDimensions>> = {
  '1080p': { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

/** The size's pixels at a scale (the tests and the preview draw smaller); always even, as video needs. */
export function videoDimensions(size: VideoSize, scale = 1): VideoDimensions {
  const d = VIDEO_DIMENSIONS[size];
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(d.width), height: even(d.height) };
}

/** A file format: a container with a video and an audio codec. */
export type VideoFormat = 'mp4-h264' | 'webm-vp9' | 'webm-av1';
/** Every `VideoFormat`, for lists and for checking loose input. */
export const VIDEO_FORMATS: readonly VideoFormat[] = ['mp4-h264', 'webm-vp9', 'webm-av1'];

/**
 * Everything the export needs to know about one file format: names for the dialog, the codec strings WebCodecs wants
 * and the bit rates (bits per second).
 */
export interface VideoFormatInfo {
  container: 'mp4' | 'webm';
  ext: 'mp4' | 'webm';
  mime: string;
  label: string;
  /** The picture codec's short name, for messages. */
  codecName: string;
  /** Plain words for the dialog. */
  note: string;
  /** WebCodecs codec string for the picture. */
  videoCodec(fps: number): string;
  /** WebCodecs codec string for the sound. */
  audioCodec: 'opus' | 'mp4a.40.2';
  /** Bits per second for 1920×1080 at 30 and at 60 frames per second (smaller or larger pictures scale with their pixels). */
  videoBitrate: readonly [number, number];
  audioBitrate: number;
}

/** The `VideoFormatInfo` of each file format. */
export const VIDEO_FORMAT_INFO: Readonly<Record<VideoFormat, VideoFormatInfo>> = {
  'mp4-h264': {
    container: 'mp4',
    ext: 'mp4',
    mime: 'video/mp4',
    label: 'MP4 (H.264)',
    codecName: 'H.264',
    note: 'Plays everywhere: phones, social apps, editors and every browser. The safest choice for sharing.',
    // High profile, level 4.0 (1080p30) or 4.2 (1080p60).
    videoCodec: (fps) => (fps > 30 ? 'avc1.64002a' : 'avc1.640028'),
    audioCodec: 'mp4a.40.2',
    videoBitrate: [7_000_000, 10_000_000],
    audioBitrate: 192_000,
  },
  'webm-vp9': {
    container: 'webm',
    ext: 'webm',
    mime: 'video/webm',
    label: 'WebM (VP9)',
    codecName: 'VP9',
    note: 'Open format: plays in Chrome, Edge, Firefox, YouTube and most editors. Good quality for its size.',
    // Profile 0, 8-bit, level 4.0 / 4.1.
    videoCodec: (fps) => (fps > 30 ? 'vp09.00.41.08' : 'vp09.00.40.08'),
    audioCodec: 'opus',
    videoBitrate: [5_000_000, 7_000_000],
    audioBitrate: 160_000,
  },
  'webm-av1': {
    container: 'webm',
    ext: 'webm',
    mime: 'video/webm',
    label: 'WebM (AV1)',
    codecName: 'AV1',
    note: 'Smallest files, but the slowest to encode, and some players cannot play AV1 yet.',
    videoCodec: () => 'av01.0.08M.08',
    audioCodec: 'opus',
    videoBitrate: [3_500_000, 5_000_000],
    audioBitrate: 160_000,
  },
};

/** The video bit rate for a format, picture size and frame rate. */
export function videoBitrate(format: VideoFormat, width: number, height: number, fps: number): number {
  const [at30, at60] = VIDEO_FORMAT_INFO[format].videoBitrate;
  const base = fps > 30 ? at60 : at30;
  const scale = (width * height) / (1920 * 1080);
  // Never starve a small picture: a floor of 400 kbps.
  return Math.max(400_000, Math.round((base * scale) / 50_000) * 50_000);
}

/** Seconds between key frames (a place a player can jump to). */
export const KEYFRAME_SECONDS = 2;

/** Sample rate of the sound in a video (Opus needs 48 kHz; AAC and video players are happiest there too). */
export const VIDEO_SAMPLE_RATE = 48000;
