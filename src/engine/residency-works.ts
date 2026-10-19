import type { ChannelId } from '@core/model/types';
import { bufferFromPcm16, copyChannels, reverseBuffer, runStretch, STRETCH_WORKERS } from './audio-buffers';
import type { ResidencyItem } from './residency-needs';
import type { SampleCache } from './samples';

/** What the buffer works need from the residency that asks them. */
export interface BufferWorksDeps {
  cache: SampleCache;
  ctx: BaseAudioContext;
  /** Buffers these channels play from became available (late clips start, stretched copies swap in). */
  onReady(channels: ReadonlySet<ChannelId>): void;
  /** A time-stretch started or finished. */
  onStretching(): void;
  /** What a finished or failed job changes: the plan may start more (a freed stretch slot, room for a prefetch). */
  queueReplan(): void;
  /** What the residency wants under a key (null when it no longer does). */
  itemOf(key: string): ResidencyItem | undefined;
  /** The bytes a buffer takes (or will take, estimated). */
  bytesOf(key: string): number;
  isDisposed(): boolean;
}

/**
 * Makes the buffers the residency wants: decodes a sample, reverses it, or time-stretches the part a clip plays (read back
 * from disk when an earlier session made the copy, else computed in the Worker pool). It keeps track of what is running
 * and what failed, and of what it learned on the way (a decoded sample's length, which stretched copies are on disk).
 * What to make and when is the residency's decision; this only does the work.
 */
export class BufferWorks {
  /** Loads in progress, by cache key. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Keys whose load failed; they are not tried again until `clearFailures`. */
  private readonly failed = new Set<string>();
  /** Decoded length of each sample (seconds), by source key, for estimating sizes. */
  private readonly durations = new Map<string, number>();
  /**
   * Stretched copies kept on disk (true) or to be computed (false); unknown until the job has
   * looked. Only a copy being computed needs its sample decoded (to compute it, and to play in time
   * meanwhile): one read back from disk doesn't, so a stretched song needs half the memory.
   */
  private readonly onDisk = new Map<string, boolean>();
  /** Stretched copies being looked for on disk (see `probe`). */
  private readonly probing = new Set<string>();
  private stretchesRunning = 0;
  /** Estimated bytes of loads started and not finished (prefetches wait while they would overflow). */
  private inflightBytesTotal = 0;

  constructor(private readonly deps: BufferWorksDeps) {}

  // ---- What is going on ----

  /** The load in progress for a key, if there is one. */
  job(key: string): Promise<unknown> | undefined {
    return this.inflight.get(key);
  }

  /** The keys being loaded now. */
  runningKeys(): IterableIterator<string> {
    return this.inflight.keys();
  }

  /** Every load in progress. */
  runningJobs(): Promise<unknown>[] {
    return [...this.inflight.values()];
  }

  /** Estimated bytes of loads started and not finished. */
  get inflightBytes(): number {
    return this.inflightBytesTotal;
  }

  hasFailed(key: string): boolean {
    return this.failed.has(key);
  }

  /** The project changed: what failed may work now (a sample was replaced), so it is tried again. */
  clearFailures(): void {
    this.failed.clear();
  }

  /** How long a sample turned out to be once decoded (seconds), or undefined while not known. */
  durationOf(sourceKey: string): number | undefined {
    return this.durations.get(sourceKey);
  }

  /** Whether a stretched copy is kept on disk: undefined until known. */
  isOnDisk(key: string): boolean | undefined {
    return this.onDisk.get(key);
  }

  // ---- Starting work ----

  /** Starts making a buffer if it is missing and nothing is making it yet. */
  start(key: string, priority: number): void {
    const cache = this.deps.cache;
    if (cache.has(key) || this.inflight.has(key) || this.failed.has(key)) return;
    const item = this.deps.itemOf(key);
    if (!item) return;
    if (item.kind === 'stretch' && this.stretchesRunning >= STRETCH_WORKERS) return;
    const job = this.makeBuffer(item, priority);
    const estimatedBytes = this.deps.bytesOf(key);
    this.inflightBytesTotal += estimatedBytes;
    const tracked = job.then(
      (buffer) => {
        this.inflightBytesTotal -= estimatedBytes;
        this.inflight.delete(key);
        if (!buffer) this.failed.add(key);
        else if (!this.deps.isDisposed()) this.deps.onReady(item.channels);
        // A finished buffer can free others (a stretched copy releases its source) or a slot.
        this.deps.queueReplan();
      },
      () => {
        this.inflightBytesTotal -= estimatedBytes;
        this.inflight.delete(key);
        this.failed.add(key);
        this.deps.queueReplan();
      },
    );
    this.inflight.set(key, tracked);
  }

  /** Looks (cheaply) whether a stretched copy is kept on disk; plans again once known. */
  probe(key: string): void {
    const store = this.deps.cache.store;
    if (!store) {
      this.onDisk.set(key, false);
      return;
    }
    if (this.probing.has(key)) return;
    this.probing.add(key);
    const has = store.has ? store.has(key) : store.get(key).then((bytes) => !!bytes);
    void has
      .catch(() => false)
      .then((found) => {
        this.probing.delete(key);
        if (!this.onDisk.has(key)) this.onDisk.set(key, found);
        this.deps.queueReplan();
      });
  }

  // ---- Making the buffers ----

  private makeBuffer(item: ResidencyItem, priority: number): Promise<AudioBuffer | null> {
    switch (item.kind) {
      case 'source':
        return this.decodeSource(item);
      case 'reverse':
        return this.deps.cache.derive(item.key, () => this.reverseOf(item));
      case 'stretch':
        return this.makeStretched(item, priority);
    }
  }

  private async decodeSource(item: ResidencyItem): Promise<AudioBuffer | null> {
    const buffer = await this.deps.cache.load(item.ref, this.deps.ctx);
    if (buffer) this.durations.set(item.key, buffer.duration);
    return buffer;
  }

  /** The sample played backwards, made from the decoded sample (decoding it first if it is not in memory). */
  private async reverseOf(item: ResidencyItem): Promise<AudioBuffer | null> {
    const cache = this.deps.cache;
    const source = cache.get(item.sourceKey) ?? (await cache.load(item.ref, this.deps.ctx));
    return source ? reverseBuffer(source) : null;
  }

  /** A time-stretched copy: read back from disk when an earlier session made it, else computed in the Worker pool. */
  private makeStretched(item: ResidencyItem, priority: number): Promise<AudioBuffer | null> {
    this.stretchesRunning++;
    this.deps.onStretching();
    return this.deps.cache
      .derive(item.key, () => this.stretchedCopy(item, priority))
      .finally(() => {
        this.stretchesRunning--;
        this.deps.onStretching();
      });
  }

  private async stretchedCopy(item: ResidencyItem, priority: number): Promise<AudioBuffer | null> {
    const cache = this.deps.cache;
    // Made in an earlier session: read it back (16-bit, exactly what was made then).
    const store = cache.store;
    const kept = store ? await store.get(item.key).catch(() => null) : null;
    this.onDisk.set(item.key, !!kept);
    // To be computed: the plan now wants the sample too (it plays while the copy is made).
    if (!kept) this.deps.queueReplan();
    if (kept) {
      const fromDisk = await bufferFromPcm16(kept);
      if (fromDisk) return fromDisk;
    }
    const base = await this.loadBase(item);
    if (!base) return null;
    const sampleRate = base.sampleRate;
    const channels = await copyChannels(base, item.from * sampleRate, Math.min(base.length, item.to * sampleRate));
    if ((channels[0]?.length ?? 0) === 0) return null;
    const pcm = await runStretch({ channels, scale: item.scale, sampleRate }, priority);
    const stretched = await bufferFromPcm16(pcm);
    if (stretched && store) void store.put(item.key, pcm).catch(() => {});
    return stretched;
  }

  /** The buffer a stretched copy is made from: the decoded sample, or its reversed copy. */
  private async loadBase(item: ResidencyItem): Promise<AudioBuffer | null> {
    const cache = this.deps.cache;
    if (item.baseKey === item.sourceKey) {
      const source = cache.get(item.sourceKey) ?? (await cache.load(item.ref, this.deps.ctx));
      if (source) this.durations.set(item.sourceKey, source.duration);
      return source;
    }
    return cache.get(item.baseKey) ?? cache.derive(item.baseKey, () => this.reverseOf(item));
  }
}
