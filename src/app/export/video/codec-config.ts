/** The WebCodecs encoder settings for a video, shared by the Worker that encodes and the dialog that checks support. */
import { VIDEO_FORMAT_INFO, type VideoFormat } from '@core/video/formats';

export interface CodecSettings {
  format: VideoFormat;
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  sampleRate: number;
}

export function videoEncoderConfig(c: CodecSettings): VideoEncoderConfig {
  return {
    codec: c.videoCodec,
    width: c.width,
    height: c.height,
    bitrate: c.videoBitrate,
    framerate: c.fps,
    latencyMode: 'quality',
    bitrateMode: 'variable',
    // MP4 wants length-prefixed NAL units and an avcC description.
    ...(VIDEO_FORMAT_INFO[c.format].container === 'mp4' ? { avc: { format: 'avc' as const } } : {}),
  };
}

export function audioEncoderConfig(c: CodecSettings): AudioEncoderConfig {
  return {
    codec: c.audioCodec,
    sampleRate: c.sampleRate,
    numberOfChannels: 2,
    bitrate: c.audioBitrate,
    // MP4 wants raw AAC packets (not ADTS) and an AudioSpecificConfig description.
    ...(VIDEO_FORMAT_INFO[c.format].container === 'mp4' ? { aac: { format: 'aac' as const } } : {}),
  };
}
