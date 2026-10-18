/**
 * The video export's Worker: takes the rendered audio a piece at a time, and for each picture of the
 * video analyses the sound around its moment, draws the frame on an OffscreenCanvas, and hands it to a
 * WebCodecs VideoEncoder; the audio goes to an AudioEncoder; both encoders' output is muxed (WebM or
 * MP4) into bytes that are posted back to be written to the file as they come. Nothing is held
 * whole: a few seconds of audio, a few frames in the encoder, one cluster in the muxer.
 */
import { AAC_PRIMING, Mp4Muxer } from '@core/io/mp4';
import { WebmMuxer, type MuxChunk, type MuxWriter } from '@core/io/webm';
import { VIDEO_FORMAT_INFO } from '@core/video/formats';
import { SpectrumAnalyzer } from '@core/video/spectrum';
import {
  audioCenterFor,
  audioTimeUs,
  frameCountFor,
  frameDurationUs,
  frameTimeUs,
  isKeyframe,
} from '@core/video/timing';
import { audioEncoderConfig, videoEncoderConfig } from './codec-config';
import { FrameRenderer } from './frames';
import type { VideoReply, VideoRequest, VideoWorkerConfig } from './protocol';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<VideoRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const post = (msg: VideoReply, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

/** The stretch of sound a frame looks at (a power of two, for the FFT). */
const WINDOW = 4096;
const HALF = WINDOW / 2;
/**
 * The window is centred this many samples behind the frame's moment, so the bars show what has just been
 * heard (a picture that leads the sound looks wrong; one that trails it by a few milliseconds does not).
 */
const LAG = 1024;
/** Samples after the frame's moment the window reaches. */
const AHEAD = HALF - LAG;
/** Frames the video encoder may hold before the Worker waits for it. */
const MAX_QUEUE = 6;

/** Pieces of the audio, kept only while a frame can still look at them. */
interface Piece {
  start: number;
  l: Float32Array;
  r: Float32Array;
}

type AnyMuxer = WebmMuxer | Mp4Muxer;

interface Run {
  cfg: VideoWorkerConfig;
  canvas: OffscreenCanvas;
  renderer: FrameRenderer;
  analyzer: SpectrumAnalyzer;
  venc: VideoEncoder;
  aenc: AudioEncoder;
  pieces: Piece[];
  /** Sample frames of audio received. */
  received: number;
  /** Next picture to draw. */
  next: number;
  window: Float32Array;
  failure: Error | null;
  muxer: AnyMuxer | null;
  /** The first output of each encoder's description (codec setup), once seen. */
  videoSeen: boolean;
  audioSeen: boolean;
  videoDescription: Uint8Array | undefined;
  audioDescription: Uint8Array | undefined;
  bytes: number;
  vChunks: MuxChunk[];
  aChunks: MuxChunk[];
}

let run: Run | null = null;
let chain: Promise<void> = Promise.resolve();

const writer: MuxWriter = {
  write(bytes) {
    if (run) run.bytes += bytes.length;
    post({ t: 'write', bytes }, [bytes.buffer as ArrayBuffer]);
  },
  patch(at, bytes) {
    post({ t: 'patch', at, bytes }, [bytes.buffer as ArrayBuffer]);
  },
};

/** A private copy of an encoder's description bytes. */
function bytesOf(d: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!d) return undefined;
  return (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();
}

/** The 4-byte av1C record for 8-bit 4:2:0 level 4.0 (the sequence header travels in the stream itself). */
const AV1C = Uint8Array.from([0x81, 0x08, 0x0c, 0x00]);

/** An OpusHead packet for stereo (when the encoder does not hand one over). */
function opusHead(channels: number, rate: number, preSkip: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  const dv = new DataView(h.buffer);
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, rate, true);
  return h;
}

function startMuxer(r: Run): void {
  if (r.muxer) return;
  const { cfg } = r;
  const info = VIDEO_FORMAT_INFO[cfg.format];
  const hasAudio = r.audioSeen;
  if (info.container === 'webm') {
    const head = r.audioDescription && r.audioDescription.length >= 19 ? r.audioDescription : opusHead(2, cfg.sampleRate, 312);
    const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
    r.muxer = new WebmMuxer(writer, {
      video: {
        codec: cfg.format === 'webm-av1' ? 'V_AV1' : 'V_VP9',
        width: cfg.width,
        height: cfg.height,
        fps: cfg.fps,
        codecPrivate: cfg.format === 'webm-av1' ? (r.videoDescription ?? AV1C) : undefined,
      },
      audio: hasAudio ? { codec: 'A_OPUS', channels: 2, sampleRate: cfg.sampleRate, codecPrivate: head, preSkip } : undefined,
      title: cfg.title || undefined,
    });
  } else {
    if (!r.videoDescription)
      throw new Error("This browser's H.264 encoder did not describe its stream, so an MP4 file cannot be written. Choose WebM instead.");
    if (hasAudio && !r.audioDescription)
      throw new Error("This browser's AAC encoder did not describe its stream, so an MP4 file cannot be written. Choose WebM instead.");
    r.muxer = new Mp4Muxer(writer, {
      video: { width: cfg.width, height: cfg.height, fps: cfg.fps, avcC: r.videoDescription },
      audio: hasAudio
        ? { channels: 2, sampleRate: cfg.sampleRate, audioSpecificConfig: r.audioDescription as Uint8Array, priming: AAC_PRIMING }
        : undefined,
      maxSeconds: cfg.seconds + 90,
      keyFrameSeconds: cfg.keyframeSeconds,
    });
  }
  for (const c of r.vChunks.splice(0)) r.muxer.addVideo(c);
  for (const c of r.aChunks.splice(0)) r.muxer.addAudio(c);
}

function onVideoChunk(r: Run, chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
  try {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (!r.videoSeen) {
      r.videoSeen = true;
      r.videoDescription = bytesOf(meta?.decoderConfig?.description);
    }
    const c: MuxChunk = {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? 0,
      key: chunk.type === 'key',
      data,
    };
    if (r.muxer) r.muxer.addVideo(c);
    else {
      r.vChunks.push(c);
      if (r.audioSeen) startMuxer(r);
    }
  } catch (e) {
    r.failure ??= e instanceof Error ? e : new Error(String(e));
  }
}

function onAudioChunk(r: Run, chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
  try {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (!r.audioSeen) {
      r.audioSeen = true;
      r.audioDescription = bytesOf(meta?.decoderConfig?.description);
    }
    const c: MuxChunk = { timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 0, key: true, data };
    if (r.muxer) r.muxer.addAudio(c);
    else {
      r.aChunks.push(c);
      if (r.videoSeen) startMuxer(r);
    }
  } catch (e) {
    r.failure ??= e instanceof Error ? e : new Error(String(e));
  }
}

const unsupported = (what: string, codec: string) =>
  new Error(`This browser cannot encode ${what} (${codec}). Try another format, or a recent Chrome or Edge.`);

async function open(cfg: VideoWorkerConfig, image: ImageBitmap | null): Promise<void> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined')
    throw new Error('This browser cannot encode video (it needs WebCodecs: use a recent Chrome or Edge).');
  const info = VIDEO_FORMAT_INFO[cfg.format];
  const vcfg = videoEncoderConfig(cfg);
  const acfg = audioEncoderConfig(cfg);
  const vs = await VideoEncoder.isConfigSupported(vcfg);
  if (!vs.supported) throw unsupported(`${info.label} video at ${cfg.width}×${cfg.height}, ${cfg.fps} fps`, cfg.videoCodec);
  const as = await AudioEncoder.isConfigSupported(acfg);
  if (!as.supported) throw unsupported(`${cfg.audioCodec === 'opus' ? 'Opus' : 'AAC'} audio`, cfg.audioCodec);

  const canvas = new OffscreenCanvas(cfg.width, cfg.height);
  const g = canvas.getContext('2d', { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D | null;
  if (!g) throw new Error('This browser could not make a drawing surface for the video.');
  const renderer = new FrameRenderer(g, {
    style: cfg.style,
    width: cfg.width,
    height: cfg.height,
    title: cfg.title,
    artist: cfg.artist,
    theme: cfg.theme,
    image,
    beats: { times: cfg.beatTimes, strong: cfg.beatStrong },
    seconds: cfg.seconds,
  });
  const analyzer = new SpectrumAnalyzer(cfg.sampleRate, renderer.bands, { fftSize: WINDOW });
  const r: Run = {
    cfg,
    canvas,
    renderer,
    analyzer,
    venc: null as unknown as VideoEncoder,
    aenc: null as unknown as AudioEncoder,
    pieces: [],
    received: 0,
    next: 0,
    window: new Float32Array(WINDOW),
    failure: null,
    muxer: null,
    videoSeen: false,
    audioSeen: false,
    videoDescription: undefined,
    audioDescription: undefined,
    bytes: 0,
    vChunks: [],
    aChunks: [],
  };
  r.venc = new VideoEncoder({
    output: (c, m) => onVideoChunk(r, c, m),
    error: (e) => (r.failure ??= new Error(`The video encoder stopped: ${e.message}`)),
  });
  r.aenc = new AudioEncoder({
    output: (c, m) => onAudioChunk(r, c, m),
    error: (e) => (r.failure ??= new Error(`The audio encoder stopped: ${e.message}`)),
  });
  r.venc.configure(vs.config ?? vcfg);
  r.aenc.configure(as.config ?? acfg);
  run = r;
}

/** Waits until the encoder can take another frame. */
async function room(enc: VideoEncoder | AudioEncoder, max: number, r: Run): Promise<void> {
  while (enc.encodeQueueSize >= max) {
    if (r.failure) throw r.failure;
    await new Promise<void>((resolve) => enc.addEventListener('dequeue', () => resolve(), { once: true }));
  }
  if (r.failure) throw r.failure;
}

/** Mono mix of [start, start + len) into `out`; zero outside the audio received. */
function readWindow(r: Run, start: number, out: Float32Array): void {
  out.fill(0);
  const end = start + out.length;
  for (const p of r.pieces) {
    const pEnd = p.start + p.l.length;
    if (pEnd <= start || p.start >= end) continue;
    const from = Math.max(start, p.start);
    const to = Math.min(end, pEnd);
    for (let i = from; i < to; i++) out[i - start] = ((p.l[i - p.start] as number) + (p.r[i - p.start] as number)) * 0.5;
  }
}

async function pushAudio(r: Run, channels: Float32Array[]): Promise<void> {
  const left = channels[0] as Float32Array;
  const right = (channels[1] ?? channels[0]) as Float32Array;
  const n = left.length;
  if (n === 0) return;
  r.pieces.push({ start: r.received, l: left, r: right });
  const planar = new Float32Array(n * 2);
  planar.set(left, 0);
  planar.set(right, n);
  await room(r.aenc, 24, r);
  r.aenc.encode(
    new AudioData({
      format: 'f32-planar',
      sampleRate: r.cfg.sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: audioTimeUs(r.received, r.cfg.sampleRate),
      data: planar,
    }),
  );
  r.received += n;
}

/** Draws and encodes every picture whose sound is here (all of them, once `final`). */
async function produce(r: Run, final: boolean): Promise<void> {
  const { cfg } = r;
  const count = final ? frameCountFor(r.received / cfg.sampleRate, cfg.fps) : Infinity;
  while (r.next < count) {
    const i = r.next;
    const moment = audioCenterFor(i, cfg.fps, cfg.sampleRate);
    if (!final && moment + AHEAD > r.received) break;
    await room(r.venc, MAX_QUEUE, r);
    readWindow(r, moment - LAG - HALF, r.window);
    const bands = r.analyzer.process(r.window, 1 / cfg.fps);
    r.renderer.draw({
      t: i / cfg.fps,
      bands,
      wave: r.window.subarray(HALF - 1024, HALF + 1024),
      level: r.analyzer.level,
    });
    const frame = new VideoFrame(r.canvas, { timestamp: frameTimeUs(i, cfg.fps), duration: frameDurationUs(i, cfg.fps) });
    r.venc.encode(frame, { keyFrame: isKeyframe(i, cfg.fps, cfg.keyframeSeconds) });
    frame.close();
    r.next++;
  }
  // Audio that no frame can look at any more is dropped.
  const keepFrom = audioCenterFor(r.next, cfg.fps, cfg.sampleRate) - LAG - HALF;
  while (r.pieces.length > 1 && (r.pieces[0] as Piece).start + (r.pieces[0] as Piece).l.length < keepFrom) r.pieces.shift();
}

async function finish(r: Run): Promise<void> {
  await produce(r, true);
  await r.venc.flush();
  await r.aenc.flush();
  if (r.failure) throw r.failure;
  if (!r.muxer) startMuxer(r);
  const m = r.muxer as AnyMuxer;
  m.endVideo();
  m.endAudio();
  m.finish();
  if (r.failure) throw r.failure;
  const frames = r.next;
  post({ t: 'done', frames, seconds: r.received / r.cfg.sampleRate, bytes: m.size });
  r.venc.close();
  r.aenc.close();
  run = null;
}

scope.onmessage = (e) => {
  const req = e.data;
  chain = chain.then(async () => {
    try {
      if (req.t === 'open') {
        await open(req.config, req.image);
        post({ t: 'opened' });
        return;
      }
      const r = run;
      if (!r) throw new Error('The video encoder is not open.');
      if (r.failure) throw r.failure;
      if (req.t === 'audio') {
        await pushAudio(r, req.channels);
        await produce(r, false);
        if (r.failure) throw r.failure;
        post({ t: 'ack', frames: r.next });
      } else {
        await finish(r);
      }
    } catch (err) {
      post({ t: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  });
};
