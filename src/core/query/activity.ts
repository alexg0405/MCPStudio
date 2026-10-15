/**
 * What plays in each bar of the song: the notes that start there per channel (pattern clips loop
 * their content as they play), the audio clips and the automation clips. The AI reads it to hear a
 * part in context ("bar 32: the hats stop, the 808 slides"). Plain loops only, so it is safe on
 * drafts too.
 */
import type { ChannelId, Project, Tick } from '../model/types';
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

/**
 * Activity per bar for every bar that overlaps from–to (whole bars). Muted clips, lanes, channels and
 * notes don't play, so they don't count.
 */
export function barActivity(p: Project, from: Tick, to: Tick): BarActivity[] {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const first = Math.max(0, Math.floor(from / bar));
  const last = Math.max(first + 1, Math.ceil(to / bar));
  const t0 = first * bar;
  const t1 = last * bar;
  const counts = Array.from({ length: last - first }, () => new Map<ChannelId, number>());
  const audio = Array.from({ length: last - first }, () => new Set<ChannelId>());
  const automation = Array.from({ length: last - first }, () => new Set<ChannelId>());
  const muted = mutedLanes(p.playlist);
  const silent = silentChannels(p);
  // The bars a span [a, b) touches, inside the window.
  const each = (a: Tick, b: Tick, fn: (i: number) => void) => {
    const i0 = Math.max(0, Math.floor((Math.max(a, t0) - t0) / bar));
    const i1 = Math.min(last - first, Math.ceil((Math.min(b, t1) - t0) / bar));
    for (let i = i0; i < i1; i++) fn(i);
  };

  for (const c of Object.values(p.playlist.clips)) {
    const end = c.start + c.length;
    if (c.muted || muted.has(c.laneId) || end <= t0 || c.start >= t1) continue;
    if (c.kind === 'audio') {
      if (!silent.has(c.channelId) && p.channels[c.channelId]) each(c.start, end, (i) => audio[i]!.add(c.channelId));
      continue;
    }
    if (c.kind === 'automation') {
      const ch = p.channels[c.channelId];
      if (ch?.kind === 'automation' && !ch.muted) each(c.start, end, (i) => automation[i]!.add(c.channelId));
      continue;
    }
    const pat = p.patterns[c.patternId];
    if (!pat) continue;
    // A copy of the pattern: the memoized length would keep a draft proxy.
    const len = patternLength({ ...pat }, ts);
    if (len <= 0) continue;
    // Song tick of content tick 0 in the first repeat that reaches into the clip.
    const origin = c.start - c.offset;
    const lo = Math.max(c.start, t0);
    const hi = Math.min(end, t1);
    for (const [key, byId] of Object.entries(pat.notes)) {
      const cid = key as ChannelId;
      if (!byId || silent.has(cid) || !p.channels[cid]) continue;
      for (const n of Object.values(byId)) {
        if (n.muted || n.tick >= len) continue;
        // Repeats of this note that start inside [lo, hi).
        let k = Math.ceil((lo - origin - n.tick) / len);
        for (let at = origin + n.tick + k * len; at < hi; k++, at += len) {
          if (at < lo) continue;
          const i = Math.floor((at - t0) / bar);
          const m = counts[i]!;
          m.set(cid, (m.get(cid) ?? 0) + 1);
        }
      }
    }
  }

  const order = new Map(p.channelOrder.map((id, i) => [id, i]));
  const byOrder = (a: ChannelId, b: ChannelId) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9);
  return counts.map((m, i) => {
    const notes = [...m.entries()]
      .sort(([a], [b]) => byOrder(a, b))
      .map(([channelId, count]) => ({ channelId, count }));
    return {
      bar: first + i + 1,
      from: t0 + i * bar,
      to: t0 + (i + 1) * bar,
      notes,
      total: notes.reduce((s, x) => s + x.count, 0),
      audio: [...audio[i]!].sort(byOrder),
      automation: [...automation[i]!].sort(byOrder),
    };
  });
}
