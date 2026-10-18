/**
 * Which video formats this browser can encode (WebCodecs), and what to tell the musician when one cannot.
 * Checked with the same encoder settings the export uses, for the chosen picture size and frame rate.
 */
import {
  VIDEO_FORMATS,
  VIDEO_FORMAT_INFO,
  VIDEO_SAMPLE_RATE,
  videoBitrate,
  videoDimensions,
  type VideoFormat,
  type VideoSize,
} from '@core/video/formats';
import { audioEncoderConfig, videoEncoderConfig } from './codec-config';

/** True when the browser has WebCodecs encoders and an OffscreenCanvas to draw on. */
export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/** What to say when the browser cannot make videos at all. */
export const NO_WEBCODECS =
  'This browser cannot make videos: it has no WebCodecs video encoder. Use a recent Chrome or Edge on a computer.';

export type FormatSupport = Record<VideoFormat, string | null>;

/** For each format: null when it works here, or the reason it does not. */
export async function probeFormats(size: VideoSize, fps: number, scale = 1): Promise<FormatSupport> {
  const out = {} as FormatSupport;
  if (!webCodecsAvailable()) {
    for (const f of VIDEO_FORMATS) out[f] = NO_WEBCODECS;
    return out;
  }
  const { width, height } = videoDimensions(size, scale);
  for (const format of VIDEO_FORMATS) {
    const info = VIDEO_FORMAT_INFO[format];
    const settings = {
      format,
      videoCodec: info.videoCodec(fps),
      audioCodec: info.audioCodec,
      width,
      height,
      fps,
      videoBitrate: videoBitrate(format, width, height, fps),
      audioBitrate: info.audioBitrate,
      sampleRate: VIDEO_SAMPLE_RATE,
    };
    try {
      const v = await VideoEncoder.isConfigSupported(videoEncoderConfig(settings));
      if (!v.supported) {
        out[format] = `This browser cannot encode ${info.codecName} video at ${width}×${height}, ${fps} fps.`;
        continue;
      }
      const a = await AudioEncoder.isConfigSupported(audioEncoderConfig(settings));
      out[format] = a.supported ? null : `This browser cannot encode ${info.audioCodec === 'opus' ? 'Opus' : 'AAC'} audio, which ${info.label} needs.`;
    } catch (e) {
      out[format] = e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}

/** The first format that works, in the order of preference (MP4 first: it plays everywhere). */
export function firstSupported(support: FormatSupport, preferred?: VideoFormat): VideoFormat | null {
  if (preferred && support[preferred] === null) return preferred;
  return VIDEO_FORMATS.find((f) => support[f] === null) ?? null;
}
