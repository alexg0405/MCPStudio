import type { SampleRef, SampleSource } from '@core/model/types';
import { readAudioInfo } from '@core/io/audio-info';
import { generateFx } from './kit/fx';
import { generate } from './kit/generators';
import type { SampleBytesProvider } from './api';
import { BudgetCache, type CacheStats } from './budget-cache';
import { decodeAudio } from './decode';
import { peaksOf } from './audio-buffers';
import type { Waveform } from './waveform';

/** Decoded audio kept by default: about 70 minutes of stereo at 48 kHz (float32). */
export const DEFAULT_SAMPLE_BUDGET = 1.5 * 1024 ** 3;

/**
 * Where copies that take long to make (time-stretched clips) are kept between sessions, by cache
 * key (the app gives one backed by OPFS). Failures just mean the copy is made again.
 */
export interface DerivedAudioStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Whether a copy is kept, without reading it (default: a get). */
  has?(key: string): Promise<boolean>;
}

export interface SampleCacheOptions {
  /** Keeps stretched copies on disk (so each is computed once per file, not once per session). */
  store?: DerivedAudioStore;
  /** Bytes of decoded audio (float32 frames × channels × 4) to keep before evicting (default 1.5 GB). */
  budgetBytes?: number;
  /** Files decoded at once (default 2): each decode briefly holds the file and its float copy. */
  maxDecodes?: number;
}

export const bufferBytes = (b: Pick<AudioBuffer, 'length' | 'numberOfChannels'>) => b.length * b.numberOfChannels * 4;

/**
 * Decoded sample cache keyed by source and sample rate, with a memory budget. Built-in (procedural)
 * samples are generated synchronously; embedded samples are decoded on demand from the bytes the
 * app provides. Copies derived from a sample (reversed, time-stretched) live in the same budget
 * under keys that start with the sample's key. AudioBuffers are not tied to a context, so one cache
 * serves every engine: the realtime one (across reboots), offline renders and probes. The app owns
 * one; an engine made without one gets its own (tests).
 *
 * Least recently used buffers go when the budget is exceeded, except pinned ones: the engine pins
 * what it is playing or about to play (sample-residency.ts) and plugins pin their sample slots.
 */
export class SampleCache {
  private readonly lru: BudgetCache<AudioBuffer>;
  /** Peak overviews survive their buffer's eviction (they are small), so the playlist doesn't re-decode to draw. */
  private readonly waveforms = new Map<string, Waveform>();
  private readonly waveformJobs = new Map<string, Promise<Waveform | null>>();
  private readonly maxDecodes: number;
  private decoding = 0;
  private readonly queue: (() => void)[] = [];
  private readonly listeners = new Set<(key: string) => void>();
  private decodes = 0;
  /** Disk copies of derived buffers (null: none). */
  readonly store: DerivedAudioStore | null;
  /** Lengths read from file headers (or a decode) for samples whose project data doesn't say, by content hash. */
  private readonly learned = new Map<string, number>();

  constructor(
    readonly provider?: SampleBytesProvider,
    opts: SampleCacheOptions = {},
  ) {
    this.lru = new BudgetCache<AudioBuffer>(opts.budgetBytes ?? DEFAULT_SAMPLE_BUDGET, bufferBytes);
    this.maxDecodes = Math.max(1, opts.maxDecodes ?? 2);
    this.store = opts.store ?? null;
  }

  /** The cache key of a sample decoded at a sample rate. */
  static keyOf(source: SampleSource, sampleRate: number): string {
    return source.kind === 'builtin'
      ? `b:${source.generator}@${source.version}:${sampleRate}`
      : `e:${source.hash}:${sampleRate}`;
  }

  get budgetBytes(): number {
    return this.lru.budgetBytes;
  }

  set budgetBytes(bytes: number) {
    this.lru.budgetBytes = bytes;
  }

  get usedBytes(): number {
    return this.lru.usedBytes;
  }

  stats(): CacheStats & { decodes: number } {
    return { ...this.lru.stats(), decodes: this.decodes };
  }

  resetPeak(): void {
    this.lru.resetPeak();
  }

  /** The buffer if it is available without waiting (built-ins always are). */
  getSync(ref: Pick<SampleRef, 'source'>, sampleRate: number): AudioBuffer | null {
    const key = SampleCache.keyOf(ref.source, sampleRate);
    const hit = this.lru.get(key);
    if (hit) return hit;
    if (ref.source.kind !== 'builtin') return null;
    // Kit sounds, then the arranger's transition sounds (risers, impacts… named fx/<kind>/…).
    const data = generate(ref.source.generator, sampleRate) ?? generateFx(ref.source.generator, sampleRate);
    if (!data || data.length === 0) return null;
    const buffer = new AudioBuffer({ length: data[0]!.length, numberOfChannels: data.length, sampleRate });
    data.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    this.lru.set(key, buffer);
    return buffer;
  }

  /**
   * The sample's length in seconds without decoding it, or null when it isn't known (yet): a decoded buffer's, a
   * built-in's (generated, a few milliseconds), what the project recorded at import, or what `learnDuration` read.
   */
  knownDuration(ref: Pick<SampleRef, 'source' | 'durationSec'>, sampleRate: number): number | null {
    const hit = this.lru.peek(SampleCache.keyOf(ref.source, sampleRate));
    if (hit) return hit.duration;
    if (ref.source.kind === 'builtin') return this.getSync(ref, sampleRate)?.duration ?? null;
    if (ref.durationSec !== undefined && Number.isFinite(ref.durationSec) && ref.durationSec > 0)
      return ref.durationSec;
    return this.learned.get(ref.source.hash) ?? null;
  }

  /**
   * Makes `knownDuration` answer for a sample whose length the project doesn't record (older projects): reads
   * it from the file's header, and decodes only a file the headers don't describe. Null when it can't be read.
   */
  async learnDuration(ref: Pick<SampleRef, 'source' | 'durationSec'>, ctx: BaseAudioContext): Promise<number | null> {
    const known = this.knownDuration(ref, ctx.sampleRate);
    if (known !== null || ref.source.kind === 'builtin') return known;
    const bytes = await this.provider?.getBytes(ref as SampleRef);
    if (!bytes) return null;
    const info = readAudioInfo(new Uint8Array(bytes));
    let seconds: number | null = info && info.durationSec > 0 ? info.durationSec : null;
    if (seconds === null) seconds = (await this.load(ref, ctx))?.duration ?? null;
    if (seconds !== null) this.learned.set(ref.source.hash, seconds);
    return seconds;
  }

  /** Decodes the sample at the context's rate (once; concurrent calls share the decode). */
  load(ref: Pick<SampleRef, 'source'>, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    const sync = this.getSync(ref, ctx.sampleRate);
    if (sync || ref.source.kind === 'builtin') return Promise.resolve(sync);
    const key = SampleCache.keyOf(ref.source, ctx.sampleRate);
    return this.lru.getOrLoad(key, () =>
      this.slot(async () => {
        const bytes = await this.provider?.getBytes(ref as SampleRef);
        if (!bytes) return null;
        try {
          this.decodes++;
          return await decodeAudio(ctx, bytes);
        } catch (e) {
          console.warn(`Can't decode sample "${(ref as SampleRef).name ?? ''}"`, e);
          return null;
        }
      }).then((b) => {
        if (b) queueMicrotask(() => this.changed(key));
        return b;
      }),
    );
  }

  /** True while the sample is being fetched or decoded. */
  isLoading(ref: Pick<SampleRef, 'source'>, sampleRate: number): boolean {
    return this.lru.isPending(SampleCache.keyOf(ref.source, sampleRate));
  }

  /** Any cached buffer by key (derived copies), marked as used. */
  get(key: string): AudioBuffer | null {
    return this.lru.get(key) ?? null;
  }

  /** A cached buffer by key without marking it as used. */
  peek(key: string): AudioBuffer | null {
    return this.lru.peek(key) ?? null;
  }

  has(key: string): boolean {
    return this.lru.has(key);
  }

  isPending(key: string): boolean {
    return this.lru.isPending(key);
  }

  /** A derived buffer by key, made by `make` once (concurrent calls share it); null when it can't be made. */
  derive(key: string, make: () => Promise<AudioBuffer | null>): Promise<AudioBuffer | null> {
    return this.lru.getOrLoad(key, make).then((b) => {
      if (b) queueMicrotask(() => this.changed(key));
      return b;
    });
  }

  /** Stores a buffer under a key (counted in the budget). */
  put(key: string, buffer: AudioBuffer): void {
    this.lru.set(key, buffer);
  }

  /** Keeps a key in memory until the returned release is called. */
  pin(key: string): () => void {
    return this.lru.pin(key);
  }

  isPinned(key: string): boolean {
    return this.lru.isPinned(key);
  }

  /** Marks keys as just used, in order (the last becomes the most recent, so it is evicted last). */
  touch(...keys: string[]): void {
    this.lru.touch(...keys);
  }

  /**
   * Frees an embedded sample's decoded buffers and derived copies (the project no longer uses it).
   * Pinned ones stay until they are released and evicted. The waveform goes too.
   */
  forgetSample(hash: string): void {
    const prefix = `e:${hash}:`;
    this.lru.deleteWhere((k) => k.startsWith(prefix));
    for (const k of [...this.waveforms.keys()]) if (k.startsWith(prefix)) this.waveforms.delete(k);
  }

  /** The sample's peak overview if it has been computed (it outlives the decoded buffer). */
  waveform(ref: Pick<SampleRef, 'source'>, sampleRate: number): Waveform | null {
    return this.waveforms.get(SampleCache.keyOf(ref.source, sampleRate)) ?? null;
  }

  /**
   * Computes the peak overview (decoding the sample if needed, without pinning it), a slice at a
   * time so a long song doesn't stall playback.
   */
  loadWaveform(ref: Pick<SampleRef, 'source'>, ctx: BaseAudioContext): Promise<Waveform | null> {
    const key = SampleCache.keyOf(ref.source, ctx.sampleRate);
    const hit = this.waveforms.get(key);
    if (hit) return Promise.resolve(hit);
    let p = this.waveformJobs.get(key);
    if (!p) {
      p = (async () => {
        const buffer = await this.load(ref, ctx);
        if (!buffer) return null;
        const w = await peaksOf(buffer);
        this.waveforms.set(key, w);
        return w;
      })().finally(() => this.waveformJobs.delete(key));
      this.waveformJobs.set(key, p);
    }
    return p;
  }

  /** Fires when a buffer finished loading (key = the cache key). */
  subscribe(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(key: string): void {
    for (const fn of this.listeners) fn(key);
  }

  /** Runs `job` when a decode slot is free. */
  private async slot<R>(job: () => Promise<R>): Promise<R> {
    // A finished job hands its slot straight to the next waiting one.
    if (this.decoding >= this.maxDecodes) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.decoding++;
    try {
      return await job();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.decoding--;
    }
  }
}
