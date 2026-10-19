/**
 * What plays in each bar of the song: the notes that start there per channel (pattern clips loop
 * their content as they play), the audio clips and the automation clips. The AI reads it to hear a
 * part in context ("bar 32: the hats stop, the 808 slides"). Plain loops only, so it is safe on
 * drafts too.
 */
import type { ChannelId, PatternClip, Project, Tick } from '../model/types';
import { ticksPerBar } from '../time/ppq';
import { mutedLanes } from './playlist';
import { patternLength } from './queries';

export interface BarActivity {
  /** 1-based bar number. */
  bar: number;
  /** Song ticks of the bar (exclusive end). */
  from: Tick;
  to: Tick;
  /** Notes starting in the bar, per channel, in channel rack order (channels without notes are left out). */
  notes: { channelId: ChannelId; count: number }[];
  /** All the notes starting in the bar. */
  total: number;
  /** Channels of the audio clips playing in the bar. */
  audio: ChannelId[];
  /** Channels of the automation clips running in the bar. */
  automation: ChannelId[];
}

/** Channels that make no sound: muted, or not soloed while another channel is (automation channels don't count). */
function silentChannels(p: Project): Set<ChannelId> {
  const list = Object.values(p.channels).filter((c) => c.kind !== 'automation');
  const anySolo = list.some((c) => c.solo);
  return new Set(list.filter((c) => c.muted || (anySolo && !c.solo)).map((c) => c.id));
}

/** The window of bars being read and what has been found in each. */
interface Window {
  /** Index (0-based) of the first bar, and the song ticks [t0, t1) of the whole window. */
  first: number;
  t0: Tick;
  t1: Tick;
  barTicks: Tick;
  /** Per bar in the window: notes per channel, audio channels, automation channels. */
  counts: Map<ChannelId, number>[];
  audio: Set<ChannelId>[];
  automation: Set<ChannelId>[];
}

/** Calls `fn` with the index (in the window) of every bar the span [a, b) touches. */
function eachBar(w: Window, a: Tick, b: Tick, fn: (i: number) => void): void {
  const bars = w.counts.length;
  const i0 = Math.max(0, Math.floor((Math.max(a, w.t0) - w.t0) / w.barTicks));
  const i1 = Math.min(bars, Math.ceil((Math.min(b, w.t1) - w.t0) / w.barTicks));
  for (let i = i0; i < i1; i++) fn(i);
}

/** Counts the notes of a pattern clip that start in the window, repeating the pattern as the clip loops it. */
function countPatternNotes(p: Project, w: Window, clip: PatternClip, silent: ReadonlySet<ChannelId>): void {
  const pat = p.patterns[clip.patternId];
  if (!pat) return;
  // A copy of the pattern: the memoized length would keep a draft proxy.
  const len = patternLength({ ...pat }, p.transport.timeSig);
  if (len <= 0) return;
  // Song tick of content tick 0 in the first repeat that reaches into the clip.
  const origin = clip.start - clip.offset;
  const lo = Math.max(clip.start, w.t0);
  const hi = Math.min(clip.start + clip.length, w.t1);
  for (const [key, byId] of Object.entries(pat.notes)) {
    const channelId = key as ChannelId;
    if (!byId || silent.has(channelId) || !p.channels[channelId]) continue;
    for (const n of Object.values(byId)) {
      if (n.muted || n.tick >= len) continue;
      // Repeats of this note that start inside [lo, hi).
      let k = Math.ceil((lo - origin - n.tick) / len);
      for (let at = origin + n.tick + k * len; at < hi; k++, at += len) {
        if (at < lo) continue;
        const counts = w.counts[Math.floor((at - w.t0) / w.barTicks)] as Map<ChannelId, number>;
        counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
      }
    }
  }
}

/**
 * Activity per bar for every bar that overlaps from–to (whole bars). Muted clips, lanes, channels and
 * notes don't play, so they don't count.
 */
export function barActivity(p: Project, from: Tick, to: Tick): BarActivity[] {
  const barTicks = ticksPerBar(p.transport.timeSig);
  const first = Math.max(0, Math.floor(from / barTicks));
  const last = Math.max(first + 1, Math.ceil(to / barTicks));
  const bars = last - first;
  const w: Window = {
    first,
    t0: first * barTicks,
    t1: last * barTicks,
    barTicks,
    counts: Array.from({ length: bars }, () => new Map<ChannelId, number>()),
    audio: Array.from({ length: bars }, () => new Set<ChannelId>()),
    automation: Array.from({ length: bars }, () => new Set<ChannelId>()),
  };
  const muted = mutedLanes(p.playlist);
  const silent = silentChannels(p);
  for (const c of Object.values(p.playlist.clips)) {
    const end = c.start + c.length;
    if (c.muted || muted.has(c.laneId) || end <= w.t0 || c.start >= w.t1) continue;
    if (c.kind === 'audio') {
      if (!silent.has(c.channelId) && p.channels[c.channelId])
        eachBar(w, c.start, end, (i) => w.audio[i]!.add(c.channelId));
    } else if (c.kind === 'automation') {
      const ch = p.channels[c.channelId];
      if (ch?.kind === 'automation' && !ch.muted) eachBar(w, c.start, end, (i) => w.automation[i]!.add(c.channelId));
    } else {
      countPatternNotes(p, w, c, silent);
    }
  }
  return summarize(p, w);
}

/** The window's findings as one `BarActivity` per bar, channels in channel rack order. */
function summarize(p: Project, w: Window): BarActivity[] {
  const order = new Map(p.channelOrder.map((id, i) => [id, i]));
  const byOrder = (a: ChannelId, b: ChannelId) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9);
  return w.counts.map((m, i) => {
    const notes = [...m.entries()]
      .sort(([a], [b]) => byOrder(a, b))
      .map(([channelId, count]) => ({ channelId, count }));
    return {
      bar: w.first + i + 1,
      from: w.t0 + i * w.barTicks,
      to: w.t0 + (i + 1) * w.barTicks,
      notes,
      total: notes.reduce((s, x) => s + x.count, 0),
      audio: [...(w.audio[i] as Set<ChannelId>)].sort(byOrder),
      automation: [...(w.automation[i] as Set<ChannelId>)].sort(byOrder),
    };
  });
}
