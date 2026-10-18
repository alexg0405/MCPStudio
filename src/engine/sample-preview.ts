import { sha256Hex } from '@core/io/hash';
import type { SampleRef } from '@core/model/types';
import type { PreviewOptions } from './api';
import { bufferFromPcm16, copyChannels, runStretch } from './audio-buffers';
import { decodeAudio } from './decode';
import { SampleCache } from './samples';

/** The audition's level until someone changes it (a linear gain). */
export const DEFAULT_PREVIEW_VOLUME = 0.8;
/** The loudest audition level (a linear gain): twice the file's own level. */
const MAX_PREVIEW_VOLUME = 2;
/** Time constant of a volume change (seconds): fast, but without a click. */
const VOLUME_TAU_SEC = 0.01;

/** The slowest and fastest audition speed (a sampler's rate: 0.125 is three octaves down, 8 three octaves up). */
const MIN_PLAY_RATE = 0.125;
const MAX_PLAY_RATE = 8;

/** A tempo match inside this distance of 1 is not worth a stretch. */
const NEGLIGIBLE_STRETCH = 0.002;
/** Stretch ratios outside this range (new length / old length) sound broken, so they are ignored. */
const MIN_STRETCH = 0.25;
const MAX_STRETCH = 4;

/** What the audition needs from the engine. */
export interface SamplePreviewHost {
  readonly ctx: BaseAudioContext;
  readonly samples: SampleCache;
  /** The preview bus every audition plays into (its gain is the audition volume). */
  readonly bus: GainNode;
  /** Starts the context if the browser's autoplay policy left it suspended. */
  resume(): Promise<void>;
  /** The context time of the song's next beat as it will be heard, or null (see Engine.nextBeatTime). */
  nextBeatTime(): number | null;
}

/** Whether an audition's stretch ratio asks for a real, sensible time stretch. */
function isUsableStretch(stretch: number | undefined): stretch is number {
  if (stretch === undefined || !Number.isFinite(stretch)) return false;
  return Math.abs(stretch - 1) > NEGLIGIBLE_STRETCH && stretch > MIN_STRETCH && stretch < MAX_STRETCH;
}

/**
 * The browser's audition: plays one sample or file at a time on the preview bus. A newer audition (or `stop()`) replaces
 * the one that sounds, and cancels one that is still being decoded.
 */
export class SamplePreview {
  private source: AudioBufferSourceNode | null = null;
  /** Releases the cache entry the sounding audition keeps pinned. */
  private releasePin: (() => void) | null = null;
  /** Counts auditions asked for: an audition that finds a newer number when its decode ends is not played. */
  private latestRequest = 0;

  constructor(private readonly host: SamplePreviewHost) {}

  /** Plays a sample of the project or the sample browser (once it is decoded). */
  playSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    const { ctx, samples } = this.host;
    void this.host.resume();
    void samples.load(ref, ctx).then((buffer) => {
      if (buffer) this.playBuffer(buffer, SampleCache.keyOf(ref.source, ctx.sampleRate));
    });
  }

  /** Decodes and plays an audio file; resolves false if it can't be decoded. */
  async playFile(bytes: ArrayBuffer, opts: PreviewOptions = {}): Promise<boolean> {
    void this.host.resume();
    const request = ++this.latestRequest;
    // Decoded once per file content (the shared cache keeps it, within its budget): clicking the
    // same file again in the browser plays at once.
    const key = `p:${await sha256Hex(new Uint8Array(bytes))}:${this.host.ctx.sampleRate}`;
    const decoded = await this.host.samples.derive(key, () => decodeAudio(this.host.ctx, bytes).catch(() => null));
    if (!decoded) return false;
    const { buffer, key: playKey } = isUsableStretch(opts.stretch)
      ? await this.stretched(decoded, key, opts.stretch)
      : { buffer: decoded, key };
    // A newer audition (or a stop) was asked for while this one decoded.
    if (request === this.latestRequest) this.playBuffer(buffer, playKey, opts);
    return true;
  }

  /** Stops the audition and cancels any that is still being decoded. */
  stop(): void {
    this.latestRequest++;
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.releasePin?.();
    this.releasePin = null;
  }

  /** Sets the audition level (a linear gain, 0 to 2); a value that is not a number means the default. */
  setVolume(gain: number): void {
    const level = Number.isFinite(gain) ? Math.min(MAX_PREVIEW_VOLUME, Math.max(0, gain)) : DEFAULT_PREVIEW_VOLUME;
    this.host.bus.gain.setTargetAtTime(level, this.host.ctx.currentTime, VOLUME_TAU_SEC);
  }

  /**
   * A tempo match that keeps the pitch: stretched once per file and ratio (kept in the cache like the decode).
   * Falls back to the unstretched file when the stretch fails.
   */
  private async stretched(
    original: AudioBuffer,
    originalKey: string,
    stretch: number,
  ): Promise<{ buffer: AudioBuffer; key: string }> {
    const stretchedKey = `${originalKey}|pst:${stretch.toFixed(4)}`;
    const stretchedBuffer = await this.host.samples.derive(stretchedKey, async () => {
      const channels = await copyChannels(original);
      return bufferFromPcm16(await runStretch({ channels, scale: stretch, sampleRate: original.sampleRate }, -1));
    });
    return stretchedBuffer ? { buffer: stretchedBuffer, key: stretchedKey } : { buffer: original, key: originalKey };
  }

  /** Plays a buffer on the preview bus; its cache entry stays pinned while it sounds. */
  private playBuffer(buffer: AudioBuffer, cacheKey: string, opts: PreviewOptions = {}): void {
    this.stop();
    const hasRate = opts.rate !== undefined && Number.isFinite(opts.rate);
    const playbackRate = hasRate ? Math.min(MAX_PLAY_RATE, Math.max(MIN_PLAY_RATE, opts.rate as number)) : 1;
    const source = new AudioBufferSourceNode(this.host.ctx, { buffer, playbackRate, loop: opts.loop === true });
    const release = this.host.samples.pin(cacheKey);
    source.connect(this.host.bus);
    source.onended = () => {
      source.disconnect();
      release();
    };
    const startAt = opts.onBeat ? this.host.nextBeatTime() : null;
    source.start(startAt ?? 0);
    this.source = source;
    this.releasePin = release;
  }
}
