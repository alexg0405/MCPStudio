/** What the main thread and the video Worker say to each other (types only). */
import type { VideoFormat, VideoStyle } from '@core/video/formats';
import type { VideoTheme } from './frames';

/** Everything the Worker needs to start a video. */
export interface VideoWorkerConfig {
  format: VideoFormat;
  /** WebCodecs codec strings, already chosen for the picture size and frame rate. */
  videoCodec: string;
  audioCodec: 'opus' | 'mp4a.40.2';
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  sampleRate: number;
  style: VideoStyle;
  theme: VideoTheme;
  title: string;
  artist: string;
  /** Beats of the exported range, seconds from its start (for the pulse). */
  beatTimes: Float64Array;
  beatStrong: Uint8Array;
  /** Seconds of music (for the progress bar and sizing the MP4 index). */
  seconds: number;
  keyframeSeconds: number;
}

export type VideoRequest =
  | { t: 'open'; config: VideoWorkerConfig; image: ImageBitmap | null }
  /** The next piece of the rendered audio (stereo, at config.sampleRate), in order. */
  | { t: 'audio'; channels: Float32Array[] }
  /** No more audio: draw the rest, flush the encoders, finish the file. */
  | { t: 'finish' };

export type VideoReply =
  | { t: 'opened' }
  /** The audio so far is drawn and encoded (the Worker is ready for more); `frames` pictures made so far. */
  | { t: 'ack'; frames: number }
  /** Bytes to append to the file. */
  | { t: 'write'; bytes: Uint8Array }
  /** Bytes to write over the file at `at` (the sizes and the index, known at the end). */
  | { t: 'patch'; at: number; bytes: Uint8Array }
  | { t: 'done'; frames: number; seconds: number; bytes: number }
  | { t: 'error'; error: string };
