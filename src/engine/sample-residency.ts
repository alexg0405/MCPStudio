/**
 * Keeps the decoded audio the song needs in memory, and no more (DJ mixes of 10–30 long songs
 * don't fit). Every playlist audio clip needs its sample decoded, reversed when the channel plays
 * backwards, and time-stretched (one copy per clip, of the part it plays) in 'stretch' mode. The
 * clips overlapping [playhead − 2 s, playhead + 30 s] have those buffers pinned in the shared
 * SampleCache; the clips after them are prefetched in playback order while they fit the budget;
 * everything else may be evicted. Offline renders call `ensure` for each chunk before it is
 * scheduled, so exports never depend on timing.
 *
 * Nothing heavy runs in one go on the main thread: decodes are the browser's (off-thread) or a
 * Worker's, stretches run in the Worker pool, reversing and copying go a slice at a time
 * (audio-buffers.ts). What each clip needs is worked out in residency-needs.ts, which buffers to
 * keep in residency-plan.ts.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode } from '@core/audio/playback';
import type { AudioClip, ChannelId, ClipId, Project, SampleRef } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import { bufferFromPcm16, copyChannels, reverseBuffer, runStretch, STRETCH_WORKERS } from './audio-buffers';
import {
  baseKeyOf,
  collectNeeds,
  plainItem,
  stretchKeyOf,
  stretchSpanOf,
  type ClipNeed,
  type ResidencyItem,
  type StretchedCopy,
} from './residency-needs';
import { planResidency } from './residency-plan';
import { SampleCache } from './samples';

export type { StretchedCopy } from './residency-needs';

/** Seconds of song before the playhead whose clips stay pinned. */
const BEHIND_SEC = 2;
/** Seconds of song ahead of the playhead whose clips are pinned (decode + stretch take ~1 s). */
const AHEAD_SEC = 30;
/** The playhead must move this far before the plan is made again (seconds). */
const REPLAN_DISTANCE_SEC = 1;
/** Share of the cache budget the plan fills (the rest is headroom for previews and analysis). */
const PLAN_SHARE = 0.85;
/**
 * How far past the window clips are prefetched (seconds of playback): five minutes while playing
 * (seeks nearby are instant; work stays spread out), a minute for offline renders (each chunk is
 * made ready before it is rendered anyway).
 */
const PREFETCH_REALTIME_SEC = 300;
const PREFETCH_OFFLINE_SEC = 60;
/** How long a sample is assumed to be (seconds) while neither its decode nor its import recorded it. */
const ASSUMED_DURATION_SEC = 60;
/** Channels a sample is assumed to have until it is decoded. */
const ASSUMED_CHANNELS = 2;
/** Bytes per sample frame of a decoded channel (32-bit float). */
const BYTES_PER_SAMPLE = 4;
/** The most rounds `settled` and `waitFor` go through: a guard against a plan that never settles. */
const MAX_WAIT_ROUNDS = 256;

/** What the residency needs from the engine. */
export interface ResidencyDeps {
  cache: SampleCache;
  ctx: BaseAudioContext;
  /** Offline renders free nothing on their own and don't forget samples. */
  offline: boolean;
  /** Buffers these channels play from became available (late clips start, stretched copies swap in). */
  onReady(channels: ReadonlySet<ChannelId>): void;
  /** A time-stretch started or finished. */
  onStretching(): void;
}

/** A loop in song seconds. */
interface LoopSec {
  start: number;
  end: number;
}

export class SampleResidency {
  private project: Project | null = null;
  private tempo: TempoMap | null = null;
  private needs: ClipNeed[] = [];
  private readonly needOfClip = new Map<ClipId, ClipNeed>();
  private readonly items = new Map<string, ResidencyItem>();
  /**
   * Stretched copies the clip launcher's audio passes play (they are not playlist clips): the item and the runs using it.
   * Kept pinned while one of those runs is alive (`endLaunch`), then they are ordinary evictable cache entries.
   */
  private readonly launchItems = new Map<string, { item: ResidencyItem; runs: Set<string> }>();
  /** Keys asked for outside the playlist (previews of an audio clip channel). */
  private readonly extraKeys = new Set<string>();
  /** Release functions of the cache pins this residency holds, by key. */
  private readonly pins = new Map<string, () => void>();
  private readonly inflight = new Map<string, Promise<unknown>>();
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
  /** The keys the last plan wants, pinned ones first. */
  private wanted: string[] = [];
  private positionSec = 0;
  /** Realtime: pins only while playing (stopped, nothing holds memory others may need, e.g. an export). */
  private playing = true;
  /** Estimated bytes of loads started and not finished (prefetches wait while they would overflow). */
  private inflightBytes = 0;
  private loop: LoopSec | null = null;
  private plannedAtSec = Number.NaN;
  private replanQueued = false;
  /** The window length of the last plan (offline renders ask for the chunk's). */
  private lastAheadSec = AHEAD_SEC;
  private disposed = false;

  constructor(private readonly deps: ResidencyDeps) {}

  private get sampleRate(): number {
    return this.deps.ctx.sampleRate;
  }

  private isCached(key: string | null): boolean {
    return !!key && this.deps.cache.has(key);
  }

  // ---- What the song needs ----

  setProject(project: Project): void {
    const prev = this.project;
    this.project = project;
    const tempo = tempoMapOf(project, 'song');
    this.tempo = tempo;
    const { needs, items } = collectNeeds(project, tempo, this.sampleRate);
    this.needs = needs;
    this.needOfClip.clear();
    for (const need of needs) this.needOfClip.set(need.clipId, need);
    this.keepItemsOutsideThePlaylist(project, items);
    this.items.clear();
    for (const [key, item] of items) this.items.set(key, item);
    this.failed.clear();
    if (!this.deps.offline && prev && prev.samples !== project.samples) this.forgetDroppedSamples(prev, project);
    this.plannedAtSec = Number.NaN;
    this.queueReplan();
  }

  /** Items asked for outside the playlist (previews, the launcher's passes) stay while a channel that plays them exists. */
  private keepItemsOutsideThePlaylist(project: Project, items: Map<string, ResidencyItem>): void {
    for (const key of this.extraKeys) {
      const item = this.items.get(key);
      if (item && [...item.channels].some((id) => project.channels[id])) {
        if (!items.has(key)) items.set(key, item);
      } else {
        this.extraKeys.delete(key);
      }
    }
    for (const [key, launched] of this.launchItems) {
      if (![...launched.item.channels].some((id) => project.channels[id]?.kind === 'audioClip')) this.launchItems.delete(key);
      else if (!items.has(key)) items.set(key, launched.item);
    }
  }

  /** Samples the project no longer has: free their buffers (undo decodes them again). */
  private forgetDroppedSamples(prev: Project, project: Project): void {
    const keptHashes = new Set(Object.values(project.samples).map((ref) => (ref.source.kind === 'embedded' ? ref.source.hash : '')));
    for (const ref of Object.values(prev.samples)) {
      if (ref.source.kind === 'embedded' && !keptHashes.has(ref.source.hash)) this.deps.cache.forgetSample(ref.source.hash);
    }
  }

  /**
   * The playhead (or where playback will start), in ticks, the loop it wraps around, and whether
   * the song is playing (only then is the window pinned; stopped, it is just loaded first).
   */
  setPosition(tick: number, loop: { start: number; end: number } | null, playing = true): void {
    const tempo = this.tempo;
    if (!tempo) return;
    const playingChanged = playing !== this.playing;
    this.playing = playing;
    this.positionSec = tempo.tickToSeconds(Math.max(0, tick));
    this.loop =
      loop && loop.end > loop.start ? { start: tempo.tickToSeconds(loop.start), end: tempo.tickToSeconds(loop.end) } : null;
    const movedFarEnough = !(Math.abs(this.positionSec - this.plannedAtSec) < REPLAN_DISTANCE_SEC);
    if (playingChanged || movedFarEnough) this.replan();
  }

  /**
   * Offline renders: makes sure everything clips overlapping [fromTick, toTick] play from is in
   * memory (and pinned) before that span is scheduled.
   */
  async ensure(fromTick: number, toTick: number): Promise<void> {
    const tempo = this.tempo;
    if (!tempo) return;
    const fromSec = tempo.tickToSeconds(Math.max(0, fromTick));
    const toSec = tempo.tickToSeconds(Math.max(fromTick, toTick));
    this.positionSec = fromSec;
    this.loop = null;
    this.replan(Math.max(AHEAD_SEC, toSec - fromSec + BEHIND_SEC));
    // What is pinned can change while waiting (a stretched copy that arrives lets its source go):
    // wait for the current pins, not the first ones.
    await this.waitFor(() => [...this.pins.keys()]);
  }

  /** Resolves when nothing the current plan started is still loading. */
  async settled(): Promise<void> {
    if (this.replanQueued) this.replan();
    for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
      const running = this.wanted.map((key) => this.inflight.get(key)).filter((job): job is Promise<unknown> => !!job);
      if (running.length === 0) return;
      await Promise.all(running);
      // Finished loads may let the plan start more (stretches waiting for a slot, prefetches for room).
      if (this.replanQueued) this.replan();
    }
  }

  // ---- What the clip players read ----

  /** The sample as an audio clip channel plays it (reversed when `reverse`), or null while it isn't decoded. */
  base(ref: SampleRef, reverse: boolean): AudioBuffer | null {
    const sourceKey = SampleCache.keyOf(ref.source, this.sampleRate);
    if (reverse) return this.deps.cache.get(baseKeyOf(sourceKey, true));
    // Built-ins are generated on the spot (again, if they were evicted).
    return ref.source.kind === 'builtin' ? this.deps.cache.getSync(ref, this.sampleRate) : this.deps.cache.get(sourceKey);
  }

  /** The cache key of what `base` returns. */
  baseKey(ref: SampleRef, reverse: boolean): string {
    return baseKeyOf(SampleCache.keyOf(ref.source, this.sampleRate), reverse);
  }

  /**
   * The clip's stretched copy at `scale`, or null while it isn't ready (the plain sample plays meanwhile). A clip of the
   * clip launcher (id `launch:<run>:<pass>`) is not in the playlist: its copy is looked up (and started) by the sample,
   * the scale and the part it plays, under the tempo `tempo` of its pass.
   */
  stretched(clip: AudioClip, scale: number, tempo?: TempoMap): (StretchedCopy & { key: string }) | null {
    if (clip.id.startsWith('launch:') && tempo) return this.launchStretched(clip, scale, tempo);
    const need = this.needOfClip.get(clip.id);
    if (!need || !need.stretchKey || need.scale !== scale) return null;
    const buffer = this.deps.cache.get(need.stretchKey);
    return buffer ? { buffer, from: need.stretchFrom, key: need.stretchKey } : null;
  }

  /** A pass of a launched slot: finds or starts its stretched copy (same key as a playlist clip at that scale and part). */
  private launchStretched(clip: AudioClip, scale: number, tempo: TempoMap): (StretchedCopy & { key: string }) | null {
    const project = this.project;
    const channel = project?.channels[clip.channelId];
    if (!project || channel?.kind !== 'audioClip' || scale === 1) return null;
    const mode = playbackMode(channel);
    const ref = project.samples[channel.sampleId];
    if (mode.follow !== 'stretch' || !ref) return null;
    const sourceKey = SampleCache.keyOf(ref.source, this.sampleRate);
    const baseKey = baseKeyOf(sourceKey, mode.reverse);
    const span = stretchSpanOf(clip, mode, tempo);
    const key = stretchKeyOf(baseKey, scale, span);
    const runId = clip.id.split(':')[1] ?? '';
    let launched = this.launchItems.get(key);
    if (!launched) {
      const channels = new Set([channel.id]);
      const sourceItem: ResidencyItem = { key: sourceKey, ...plainItem('source', ref, sourceKey), channels };
      if (!this.items.has(sourceKey)) this.items.set(sourceKey, sourceItem);
      if (mode.reverse && !this.items.has(baseKey)) {
        this.items.set(baseKey, { key: baseKey, ...plainItem('reverse', ref, sourceKey), channels: new Set([channel.id]) });
      }
      const item: ResidencyItem = { key, kind: 'stretch', ref, sourceKey, baseKey, scale, from: span.from, to: span.to, channels: new Set([channel.id]) };
      this.items.set(key, item);
      this.launchItems.set(key, (launched = { item, runs: new Set() }));
      this.queueReplan();
    }
    launched.runs.add(runId);
    const buffer = this.deps.cache.get(key);
    return buffer ? { buffer, from: span.from, key } : null;
  }

  /**
   * The clip launcher's runs that are still alive (their ids): copies made only for others are no longer kept pinned,
   * and become ordinary cache entries (evictable, and read back from disk when needed again).
   */
  endLaunch(alive: ReadonlySet<string>): void {
    let changed = false;
    for (const [key, launched] of this.launchItems) {
      for (const runId of [...launched.runs]) {
        if (alive.has(runId)) continue;
        launched.runs.delete(runId);
        changed = true;
      }
      if (launched.runs.size === 0) {
        this.launchItems.delete(key);
        if (!this.needs.some((need) => need.stretchKey === key)) this.items.delete(key);
      }
    }
    if (changed) this.queueReplan();
  }

  /**
   * Something plays (or waits to play) from these buffers: makes sure they are on their way.
   * Previews of a channel whose sample isn't on the playlist come through here.
   */
  request(ref: SampleRef, reverse: boolean, channelId: ChannelId): void {
    const sourceKey = SampleCache.keyOf(ref.source, this.sampleRate);
    const keys = reverse ? [sourceKey, baseKeyOf(sourceKey, true)] : [sourceKey];
    for (const key of keys) {
      const item = this.items.get(key);
      if (item && !this.extraKeys.has(key)) {
        // A playlist clip's buffer: the plan pins it while it is in the window; just hurry it.
        item.channels.add(channelId);
        this.start(key, 0);
        continue;
      }
      if (item) {
        item.channels.add(channelId);
      } else {
        const kind = key === sourceKey ? 'source' : 'reverse';
        this.items.set(key, { key, ...plainItem(kind, ref, sourceKey), channels: new Set([channelId]) });
      }
      this.extraKeys.add(key);
    }
    this.queueReplan();
  }

  /** Keeps a buffer in memory while a voice plays it; call the returned release when it stops. */
  hold(key: string): () => void {
    return this.deps.cache.pin(key);
  }

  /** True while a stretched copy for one of the channel's clips is being made. */
  isStretching(channelId: ChannelId): boolean {
    for (const key of this.inflight.keys()) {
      const item = this.items.get(key);
      if (item?.kind === 'stretch' && item.channels.has(channelId)) return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    for (const release of this.pins.values()) release();
    this.pins.clear();
  }

  // ---- Planning ----

  private queueReplan(): void {
    if (this.replanQueued) return;
    this.replanQueued = true;
    queueMicrotask(() => {
      if (this.replanQueued) this.replan();
    });
  }

  /** Pins the window, starts loads in priority order; returns the pinned keys. */
  private replan(aheadSec = this.deps.offline ? this.lastAheadSec : AHEAD_SEC): string[] {
    this.replanQueued = false;
    this.lastAheadSec = aheadSec;
    if (this.disposed) return [];
    const cache = this.deps.cache;
    this.refreshNeedKeys();
    const always = this.keysNeededAnyway();
    const plan = planResidency({
      clips: this.needs,
      always,
      pos: this.positionSec,
      loop: this.loop,
      behind: BEHIND_SEC,
      ahead: aheadSec,
      bytesOf: (key) => this.bytesOf(key),
      budget: cache.budgetBytes * PLAN_SHARE,
      prefetchWithin: this.deps.offline ? PREFETCH_OFFLINE_SEC : PREFETCH_REALTIME_SEC,
    });
    this.plannedAtSec = this.positionSec;
    // Pins: the window's buffers (decoded or not yet) while the song plays or renders; everything
    // else may be evicted. Stopped, the window is only loaded first.
    const pinNow = this.deps.offline || this.playing;
    const pinned = new Set(pinNow ? plan.pinned : always);
    this.updatePins(pinned);
    // Recency: far prefetches oldest, the window newest, so eviction takes the far ones first.
    cache.touch(...[...plan.prefetch].reverse(), ...plan.pinned);
    this.wanted = [...plan.pinned, ...plan.prefetch];
    this.startWanted(pinned);
    return pinNow ? plan.pinned : always;
  }

  /** Each clip's keys to have: its stretched copy, else (until the copy is there) the plain sample it plays meanwhile. */
  private refreshNeedKeys(): void {
    for (const need of this.needs) {
      const stretchKey = need.stretchKey;
      // A clip with its stretched copy needs nothing else; until then it plays the plain sample.
      if (stretchKey && !this.isCached(stretchKey) && !this.onDisk.has(stretchKey)) this.probe(stretchKey);
      const keys: string[] = [];
      if (stretchKey) keys.push(stretchKey);
      const copyMustBeComputed = !stretchKey || this.onDisk.get(stretchKey) === false || !this.deps.cache.store;
      if (!this.isCached(stretchKey) && copyMustBeComputed) {
        keys.push(need.baseKey);
        if (need.baseKey !== need.sourceKey && !this.isCached(need.baseKey)) keys.push(need.sourceKey);
      }
      need.keys = keys;
    }
  }

  /** Keys needed whatever the position: the launcher's passes and what previews play (with what they are made from). */
  private keysNeededAnyway(): string[] {
    const keys: string[] = [];
    for (const [key, launched] of this.launchItems) {
      keys.push(key);
      if (!this.isCached(key)) keys.push(launched.item.baseKey, launched.item.sourceKey);
    }
    for (const key of this.extraKeys) {
      keys.push(key);
      const item = this.items.get(key);
      if (item && item.kind !== 'source' && !this.isCached(key)) keys.push(item.sourceKey);
    }
    return keys;
  }

  /** Releases the pins that are not wanted any more and takes the new ones. */
  private updatePins(pinned: ReadonlySet<string>): void {
    for (const [key, release] of this.pins) {
      if (pinned.has(key)) continue;
      this.pins.delete(key);
      release();
    }
    for (const key of pinned) if (!this.pins.has(key)) this.pins.set(key, this.deps.cache.pin(key));
  }

  /**
   * Pinned loads always start; the others only while they fit beside what is in memory, so a
   * prefetch never pushes out something another engine (an export, the realtime one) holds.
   */
  private startWanted(pinned: ReadonlySet<string>): void {
    const cache = this.deps.cache;
    const room = cache.budgetBytes * PLAN_SHARE;
    this.wanted.forEach((key, priority) => {
      if (pinned.has(key)) this.start(key, priority);
      else if (cache.has(key) || this.inflight.has(key)) return;
      else if (cache.usedBytes + this.inflightBytes + this.bytesOf(key) <= room) this.start(key, priority);
    });
  }

  /** Looks (cheaply) whether a stretched copy is kept on disk; plans again once known. */
  private probe(key: string): void {
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
        this.queueReplan();
      });
  }

  /** The bytes a buffer takes (or will take, estimated from what is known of its sample). */
  private bytesOf(key: string): number {
    const cached = this.deps.cache.peek(key);
    if (cached) return cached.length * cached.numberOfChannels * BYTES_PER_SAMPLE;
    const item = this.items.get(key);
    if (!item) return 0;
    const channels = item.ref.channels ?? ASSUMED_CHANNELS;
    const durationSec = this.durations.get(item.sourceKey) ?? item.ref.durationSec ?? ASSUMED_DURATION_SEC;
    const seconds = item.kind === 'stretch' ? (Math.min(durationSec, item.to) - item.from) * item.scale : durationSec;
    return Math.max(0, seconds) * this.sampleRate * channels * BYTES_PER_SAMPLE;
  }

  /** Starts what is missing among `keysNow()` and waits for it, until everything wanted is in the cache (or failed). */
  private async waitFor(keysNow: () => readonly string[]): Promise<void> {
    for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
      if (this.replanQueued) this.replan(this.lastAheadSec);
      const missing = keysNow().filter((key) => !this.deps.cache.has(key) && !this.failed.has(key) && this.items.has(key));
      if (missing.length === 0) return;
      for (const key of missing) this.start(key, 0);
      const running = missing.map((key) => this.inflight.get(key)).filter((job): job is Promise<unknown> => !!job);
      if (running.length > 0) {
        await Promise.all(running);
        continue;
      }
      // Waiting for a stretch slot: one of the running jobs frees it.
      const anyJob = [...this.inflight.values()];
      if (anyJob.length === 0) return;
      await Promise.race(anyJob);
    }
  }

  // ---- Making the buffers ----

  /** Starts making a buffer if it is missing and nothing is making it yet. */
  private start(key: string, priority: number): void {
    const cache = this.deps.cache;
    if (cache.has(key) || this.inflight.has(key) || this.failed.has(key)) return;
    const item = this.items.get(key);
    if (!item) return;
    if (item.kind === 'stretch' && this.stretchesRunning >= STRETCH_WORKERS) return;
    const job = this.makeBuffer(item, priority);
    const estimatedBytes = this.bytesOf(key);
    this.inflightBytes += estimatedBytes;
    const tracked = job.then(
      (buffer) => {
        this.inflightBytes -= estimatedBytes;
        this.inflight.delete(key);
        if (!buffer) this.failed.add(key);
        else if (!this.disposed) this.deps.onReady(item.channels);
        // A finished buffer can free others (a stretched copy releases its source) or a slot.
        this.queueReplan();
      },
      () => {
        this.inflightBytes -= estimatedBytes;
        this.inflight.delete(key);
        this.failed.add(key);
        this.queueReplan();
      },
    );
    this.inflight.set(key, tracked);
  }

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
    if (!kept) this.queueReplan();
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
