/**
 * A keyed cache with a byte budget: least recently used entries go first when it is over budget,
 * pinned ones never (a pin says "the engine plays this now"). Loads are deduplicated per key.
 * Pure TypeScript (no Web Audio), so the policy is unit-tested in Node; SampleCache stores decoded
 * AudioBuffers in it.
 */
export interface CacheStats {
  entries: number;
  /** Bytes held now (pinned ones included). */
  bytes: number;
  /** Bytes held by pinned entries. */
  pinnedBytes: number;
  budget: number;
  /** The most bytes held at once since the cache was made (or since resetPeak). */
  peakBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  /** Loads that ran (a deduplicated request counts once). */
  loads: number;
}

interface Entry<T> {
  value: T;
  bytes: number;
}

/** A cache of values with a byte budget: the least recently used entries go first, pinned ones stay, and a load in progress is shared by everyone who asks. */
export class BudgetCache<T> {
  /** Map order is recency: the first entry is the least recently used. */
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pins = new Map<string, number>();
  private readonly pending = new Map<string, Promise<T | null>>();
  private used = 0;
  private peak = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private loads = 0;
  /** Called after an entry was dropped to make room (or deleted). */
  onDrop: ((key: string) => void) | null = null;

  constructor(
    private budget: number,
    private readonly sizeOf: (value: T) => number,
  ) {}

  get budgetBytes(): number {
    return this.budget;
  }

  set budgetBytes(bytes: number) {
    this.budget = Math.max(0, bytes);
    this.evict();
  }

  get usedBytes(): number {
    return this.used;
  }

  /** The entry, marked as just used. */
  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  /** The entry without changing its recency. */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Marks entries as just used, in order (the last one becomes the most recent). */
  touch(...keys: string[]): void {
    for (const key of keys) {
      const e = this.entries.get(key);
      if (!e) continue;
      this.entries.delete(key);
      this.entries.set(key, e);
    }
  }

  set(key: string, value: T): void {
    const old = this.entries.get(key);
    if (old) {
      this.used -= old.bytes;
      this.entries.delete(key);
    }
    const bytes = this.sizeOf(value);
    this.entries.set(key, { value, bytes });
    this.used += bytes;
    this.peak = Math.max(this.peak, this.used);
    this.evict();
  }

  delete(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    this.used -= e.bytes;
    this.onDrop?.(key);
    return true;
  }

  /** Drops the unpinned entries whose key matches; returns how many went. */
  deleteWhere(match: (key: string) => boolean): number {
    let n = 0;
    for (const key of [...this.entries.keys()]) if (match(key) && !this.isPinned(key) && this.delete(key)) n++;
    return n;
  }

  /**
   * Keeps `key` from being evicted until the returned release is called (pins count up; a key can be
   * pinned before it is loaded). Releasing twice is harmless.
   */
  pin(key: string): () => void {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.pins.get(key) ?? 1) - 1;
      if (n <= 0) this.pins.delete(key);
      else this.pins.set(key, n);
      if (n <= 0) this.evict();
    };
  }

  isPinned(key: string): boolean {
    return (this.pins.get(key) ?? 0) > 0;
  }

  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /**
   * The entry, or the result of `load` (stored unless null). Concurrent calls for one key share one
   * load. A load that throws resolves null.
   */
  getOrLoad(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    let p = this.pending.get(key);
    if (!p) {
      this.loads++;
      p = (async () => {
        try {
          const value = await load();
          if (value !== null) this.set(key, value);
          return value;
        } catch {
          return null;
        } finally {
          this.pending.delete(key);
        }
      })();
      this.pending.set(key, p);
    }
    return p;
  }

  /** Drops least recently used unpinned entries until the cache fits its budget. */
  evict(): void {
    if (this.used <= this.budget) return;
    for (const [key, e] of this.entries) {
      if (this.used <= this.budget) break;
      if (this.isPinned(key)) continue;
      this.entries.delete(key);
      this.used -= e.bytes;
      this.evictions++;
      this.onDrop?.(key);
    }
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  resetPeak(): void {
    this.peak = this.used;
  }

  stats(): CacheStats {
    let pinnedBytes = 0;
    for (const [key, e] of this.entries) if (this.isPinned(key)) pinnedBytes += e.bytes;
    return {
      entries: this.entries.size,
      bytes: this.used,
      pinnedBytes,
      budget: this.budget,
      peakBytes: this.peak,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      loads: this.loads,
    };
  }
}
