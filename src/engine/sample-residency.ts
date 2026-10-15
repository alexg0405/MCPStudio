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
 * (audio-buffers.ts).
 */
import { tempoMapOf } from '@core/automation/tempo';
import { clipSourceRange, playbackMode, stretchScale } from '@core/audio/playback';
import type { AudioClip, ChannelId, ClipId, Project, SampleRef } from '@core/model/types';
import { audibleClips } from '@core/query/playlist';
import { effectivelyMuted } from '@core/query/queries';
import type { TempoMap } from '@core/time/ppq';
import { bufferFromPcm16, copyChannels, reverseBuffer, runStretch, STRETCH_WORKERS } from './audio-buffers';
import { planResidency, type ClipSpan } from './residency-plan';
import { SampleCache } from './samples';

/** Seconds of song before the playhead whose clips stay pinned. */
const BEHIND = 2;
/** Seconds of song ahead of the playhead whose clips are pinned (decode + stretch take ~1 s). */
const AHEAD = 30;
/** Seconds of extra source around a clip's part in its stretched copy (trim edits reuse it). */
const STRETCH_MARGIN = 1;
/** The playhead must move this far before the plan is made again. */
const REPLAN_SEC = 1;
/** Share of the cache budget the plan fills (the rest is headroom for previews and analysis). */
const PLAN_SHARE = 0.85;

type Kind = 'source' | 'reverse' | 'stretch';

interface Item {
  key: string;
  kind: Kind;
  ref: SampleRef;
  sourceKey: string;
  /** reverse/stretch: the buffer it is made from. */
  baseKey: string;
  scale: number;
  /** stretch: seconds of the base buffer copied (before clamping to its length). */
  from: number;
  to: number;
  channels: Set<ChannelId>;
}

interface ClipNeed extends ClipSpan {
  clipId: ClipId;
  channelId: ChannelId;
  sourceKey: string;
  baseKey: string;
  stretchKey: string | null;
  scale: number;
  /** Seconds of the base buffer where the stretched copy starts. */
  stretchFrom: number;
}

export interface StretchedCopy {
  buffer: AudioBuffer;
  /** Seconds into the played (base) sample at the copy's first frame. */
  from: number;
}

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

export class SampleResidency {
  private project: Project | null = null;
  private tempo: TempoMap | null = null;
  private needs: ClipNeed[] = [];
  private readonly byClip = new Map<ClipId, ClipNeed>();
  private readonly items = new Map<string, Item>();
  /** Keys asked for outside the playlist (previews of an audio clip channel). */
  private readonly extra = new Set<string>();
  private readonly pins = new Map<string, () => void>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly failed = new Set<string>();
  private readonly durations = new Map<string, number>();
  private stretchesRunning = 0;
  private wanted: string[] = [];
  private pos = 0;
  private loop: { start: number; end: number } | null = null;
  private plannedAt = Number.NaN;
  private replanQueued = false;
  private disposed = false;

  constructor(private readonly deps: ResidencyDeps) {}

  private get sr(): number {
    return this.deps.ctx.sampleRate;
  }

  // ---- What the song needs ----

  setProject(p: Project): void {
    const prev = this.project;
    this.project = p;
    this.tempo = tempoMapOf(p, 'song');
    const tempo = this.tempo;
    const muted = effectivelyMuted(p.channels);
    const needs: ClipNeed[] = [];
    const items = new Map<string, Item>();
    const item = (key: string, init: Omit<Item, 'key' | 'channels'>, channelId: ChannelId) => {
      let it = items.get(key);
      if (!it) items.set(key, (it = { ...init, key, channels: new Set() }));
      it.channels.add(channelId);
      return it;
    };
    for (const clip of audibleClips(p)) {
      if (clip.kind !== 'audio') continue;
      const ch = p.channels[clip.channelId];
      if (ch?.kind !== 'audioClip' || muted.has(ch.id)) continue;
      const ref = p.samples[ch.sampleId];
      if (!ref) continue;
      const mode = playbackMode(ch);
      const sourceKey = SampleCache.keyOf(ref.source, this.sr);
      const baseKey = mode.reverse ? `${sourceKey}|rev` : sourceKey;
      item(sourceKey, { kind: 'source', ref, sourceKey, baseKey: sourceKey, scale: 1, from: 0, to: 0 }, ch.id);
      if (mode.reverse) item(baseKey, { kind: 'reverse', ref, sourceKey, baseKey: sourceKey, scale: 1, from: 0, to: 0 }, ch.id);
      const scale = mode.follow === 'stretch' ? stretchScale(mode, tempo, clip.start) : 1;
      let stretchKey: string | null = null;
      let stretchFrom = 0;
      if (scale !== 1) {
        // Only the part the clip plays (plus a margin), on whole seconds so small trims reuse it. The
        // key doesn't depend on the sample's length (known only once decoded); the copy is clamped to it.
        const r = clipSourceRange(clip, mode, tempo, Infinity);
        const from = Math.max(0, Math.floor(r.from - STRETCH_MARGIN));
        const to = Math.ceil(r.to + STRETCH_MARGIN);
        // 'st2': the WSOLA version (copies kept on disk by an older one are not reused).
        stretchKey = `${baseKey}|st2:${scale}:${from}-${to}`;
        stretchFrom = from;
        item(stretchKey, { kind: 'stretch', ref, sourceKey, baseKey, scale, from, to }, ch.id);
      }
      const need: ClipNeed = {
        clipId: clip.id,
        channelId: ch.id,
        start: tempo.tickToSeconds(clip.start),
        end: tempo.tickToSeconds(clip.start + clip.length),
        keys: [],
        sourceKey,
        baseKey,
        stretchKey,
        scale,
        stretchFrom,
      };
      needs.push(need);
    }
    this.needs = needs;
    this.byClip.clear();
    for (const n of needs) this.byClip.set(n.clipId, n);
    // Keep the extra (preview) items of channels that still exist.
    for (const key of this.extra) {
      const it = this.items.get(key);
      if (it && [...it.channels].some((id) => p.channels[id])) {
        if (!items.has(key)) items.set(key, it);
      }
      else this.extra.delete(key);
    }
    this.items.clear();
    for (const [k, v] of items) this.items.set(k, v);
    this.failed.clear();
    // Samples the project no longer has: free their buffers (undo decodes them again).
    if (!this.deps.offline && prev && prev.samples !== p.samples) {
      const keep = new Set(Object.values(p.samples).map((r) => (r.source.kind === 'embedded' ? r.source.hash : '')));
      for (const r of Object.values(prev.samples))
        if (r.source.kind === 'embedded' && !keep.has(r.source.hash)) this.deps.cache.forgetSample(r.source.hash);
    }
    this.plannedAt = Number.NaN;
    this.queueReplan();
  }

  /** The playhead (or where playback will start), in ticks, and the loop it wraps around. */
  setPosition(tick: number, loop: { start: number; end: number } | null): void {
    const tempo = this.tempo;
    if (!tempo) return;
    this.pos = tempo.tickToSeconds(Math.max(0, tick));
    this.loop = loop && loop.end > loop.start ? { start: tempo.tickToSeconds(loop.start), end: tempo.tickToSeconds(loop.end) } : null;
    if (!(Math.abs(this.pos - this.plannedAt) < REPLAN_SEC)) this.replan();
  }

  /**
   * Offline renders: makes sure everything clips overlapping [fromTick, toTick] play from is in
   * memory (and pinned) before that span is scheduled.
   */
  async ensure(fromTick: number, toTick: number): Promise<void> {
    const tempo = this.tempo;
    if (!tempo) return;
    const a = tempo.tickToSeconds(Math.max(0, fromTick));
    const b = tempo.tickToSeconds(Math.max(fromTick, toTick));
    this.pos = a;
    this.loop = null;
    const keys = this.replan(Math.max(AHEAD, b - a + BEHIND));
    await this.waitFor(keys);
  }

  /** Resolves when nothing the current plan started is still loading. */
  async settled(): Promise<void> {
    if (this.replanQueued) this.replan();
    await this.waitFor(this.wanted);
  }

  // ---- What the clip players read ----

  /** The sample as an audio clip channel plays it (reversed when `reverse`), or null while it isn't decoded. */
  base(ref: SampleRef, reverse: boolean): AudioBuffer | null {
    const sourceKey = SampleCache.keyOf(ref.source, this.sr);
    if (reverse) return this.deps.cache.get(`${sourceKey}|rev`);
    // Built-ins are generated on the spot (again, if they were evicted).
    return ref.source.kind === 'builtin' ? this.deps.cache.getSync(ref, this.sr) : this.deps.cache.get(sourceKey);
  }

  /** The cache key of what `base` returns. */
  baseKey(ref: SampleRef, reverse: boolean): string {
    const sourceKey = SampleCache.keyOf(ref.source, this.sr);
    return reverse ? `${sourceKey}|rev` : sourceKey;
  }

  /** The clip's stretched copy at `scale`, or null while it isn't ready (the plain sample plays meanwhile). */
  stretched(clip: AudioClip, scale: number): (StretchedCopy & { key: string }) | null {
    const n = this.byClip.get(clip.id);
    if (!n || !n.stretchKey || n.scale !== scale) return null;
    const buffer = this.deps.cache.get(n.stretchKey);
    return buffer ? { buffer, from: n.stretchFrom, key: n.stretchKey } : null;
  }

  /**
   * Something plays (or waits to play) from these buffers: makes sure they are on their way.
   * Previews of a channel whose sample isn't on the playlist come through here.
   */
  request(ref: SampleRef, reverse: boolean, channelId: ChannelId): void {
    const sourceKey = SampleCache.keyOf(ref.source, this.sr);
    const keys = reverse ? [sourceKey, `${sourceKey}|rev`] : [sourceKey];
    for (const key of keys) {
      if (this.items.has(key)) {
        this.items.get(key)!.channels.add(channelId);
      } else {
        const kind: Kind = key === sourceKey ? 'source' : 'reverse';
        this.items.set(key, { key, kind, ref, sourceKey, baseKey: sourceKey, scale: 1, from: 0, to: 0, channels: new Set([channelId]) });
      }
      this.extra.add(key);
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
      const it = this.items.get(key);
      if (it?.kind === 'stretch' && it.channels.has(channelId)) return true;
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
  private replan(ahead = AHEAD): string[] {
    this.replanQueued = false;
    if (this.disposed) return [];
    const cache = this.deps.cache;
    const ready = (k: string | null) => !!k && cache.has(k);
    for (const n of this.needs) {
      // A clip with its stretched copy needs nothing else; until then it plays the plain sample.
      const keys: string[] = [];
      if (n.stretchKey) keys.push(n.stretchKey);
      if (!ready(n.stretchKey)) {
        keys.push(n.baseKey);
        if (n.baseKey !== n.sourceKey && !ready(n.baseKey)) keys.push(n.sourceKey);
      }
      n.keys = keys;
    }
    const always: string[] = [];
    for (const k of this.extra) {
      always.push(k);
      const it = this.items.get(k);
      if (it && it.kind !== 'source' && !ready(k)) always.push(it.sourceKey);
    }
    const plan = planResidency({
      clips: this.needs,
      always,
      pos: this.pos,
      loop: this.loop,
      behind: BEHIND,
      ahead,
      bytesOf: (k) => this.bytesOf(k),
      budget: cache.budgetBytes * PLAN_SHARE,
    });
    this.plannedAt = this.pos;
    // Pins: the window's buffers (decoded or not yet); everything else may be evicted.
    const pinned = new Set(plan.pinned);
    for (const [k, release] of this.pins)
      if (!pinned.has(k)) {
        this.pins.delete(k);
        release();
      }
    for (const k of pinned) if (!this.pins.has(k)) this.pins.set(k, cache.pin(k));
    // Recency: far prefetches oldest, the window newest, so eviction takes the far ones first.
    cache.touch(...[...plan.prefetch].reverse(), ...plan.pinned);
    this.wanted = [...plan.pinned, ...plan.prefetch];
    plan.pinned.forEach((k, i) => this.start(k, i));
    plan.prefetch.forEach((k, i) => this.start(k, plan.pinned.length + i));
    return plan.pinned;
  }

  private bytesOf(key: string): number {
    const cached = this.deps.cache.peek(key);
    if (cached) return cached.length * cached.numberOfChannels * 4;
    const it = this.items.get(key);
    if (!it) return 0;
    const ch = it.ref.channels ?? 2;
    const dur = this.durations.get(it.sourceKey) ?? it.ref.durationSec ?? 60;
    const seconds = it.kind === 'stretch' ? (Math.min(dur, it.to) - it.from) * it.scale : dur;
    return Math.max(0, seconds) * this.sr * ch * 4;
  }

  private async waitFor(keys: readonly string[]): Promise<void> {
    for (let guard = 0; guard < 64; guard++) {
      const missing = keys.filter((k) => !this.deps.cache.has(k) && !this.failed.has(k) && this.items.has(k));
      if (missing.length === 0) return;
      for (const k of missing) this.start(k, 0);
      const running = missing.map((k) => this.inflight.get(k)).filter((p): p is Promise<unknown> => !!p);
      if (running.length === 0) {
        // Waiting for a stretch slot: one of the running jobs frees it.
        const any = [...this.inflight.values()];
        if (any.length === 0) return;
        await Promise.race(any);
      } else await Promise.all(running);
    }
  }

  /** Starts making a buffer if it is missing and nothing is making it yet. */
  private start(key: string, priority: number): void {
    const cache = this.deps.cache;
    if (cache.has(key) || this.inflight.has(key) || this.failed.has(key)) return;
    const it = this.items.get(key);
    if (!it) return;
    if (it.kind === 'stretch' && this.stretchesRunning >= STRETCH_WORKERS) return;
    let job: Promise<AudioBuffer | null>;
    if (it.kind === 'source') {
      job = cache.load(it.ref, this.deps.ctx).then((b) => {
        if (b) this.durations.set(key, b.duration);
        return b;
      });
    } else if (it.kind === 'reverse') {
      job = cache.derive(key, async () => {
        const src = cache.get(it.sourceKey) ?? (await cache.load(it.ref, this.deps.ctx));
        return src ? reverseBuffer(src) : null;
      });
    } else {
      this.stretchesRunning++;
      this.deps.onStretching();
      job = cache
        .derive(key, async () => {
          // Made in an earlier session: read it back (16-bit, exactly what was made then).
          const store = cache.store;
          const kept = store ? await store.get(key).catch(() => null) : null;
          if (kept) {
            const b = await bufferFromPcm16(kept);
            if (b) return b;
          }
          const base = await this.loadBase(it);
          if (!base) return null;
          const sr = base.sampleRate;
          const channels = await copyChannels(base, it.from * sr, Math.min(base.length, it.to * sr));
          if ((channels[0]?.length ?? 0) === 0) return null;
          const bytes = await runStretch({ channels, scale: it.scale, sampleRate: sr }, priority);
          const b = await bufferFromPcm16(bytes);
          if (b && store) void store.put(key, bytes).catch(() => {});
          return b;
        })
        .finally(() => {
          this.stretchesRunning--;
          this.deps.onStretching();
        });
    }
    const p = job.then(
      (b) => {
        this.inflight.delete(key);
        if (!b) this.failed.add(key);
        else if (!this.disposed) this.deps.onReady(it.channels);
        // A finished buffer can free others (a stretched copy releases its source) or a slot.
        this.queueReplan();
      },
      () => {
        this.inflight.delete(key);
        this.failed.add(key);
        this.queueReplan();
      },
    );
    this.inflight.set(key, p);
  }

  private async loadBase(it: Item): Promise<AudioBuffer | null> {
    const cache = this.deps.cache;
    if (it.baseKey === it.sourceKey) {
      const b = cache.get(it.sourceKey) ?? (await cache.load(it.ref, this.deps.ctx));
      if (b) this.durations.set(it.sourceKey, b.duration);
      return b;
    }
    return (
      cache.get(it.baseKey) ??
      cache.derive(it.baseKey, async () => {
        const src = cache.get(it.sourceKey) ?? (await cache.load(it.ref, this.deps.ctx));
        return src ? reverseBuffer(src) : null;
      })
    );
  }
}
