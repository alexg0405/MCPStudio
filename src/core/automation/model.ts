/**
 * Which automation clips drive which target, as spans on the song timeline. Rules (song mode only):
 * before a target's first clip it has its document value; inside a clip, the clip's curve (content
 * tick = song tick − clip start + offset; content doesn't repeat); after a clip ends it holds the last
 * value that clip produced; where clips overlap, the latest-starting one wins. Muted clips, lanes and
 * automation channels don't count.
 */
import { targetKey } from '../model/targets';
import type { AutoPoint, AutomationChannel, ChannelId, ClipId, ParamTarget, Project, Tick } from '../model/types';
import { clipsSorted, mutedLanes } from '../query/playlist';
import { curveAt } from './curve';

/**
 * The stretch of the song one automation clip drives its target: the clip, its channel, where it starts and ends (song
 * ticks), its content offset and its curve points.
 */
export interface AutoSpan {
  clipId: ClipId;
  channelId: ChannelId;
  start: Tick;
  end: Tick;
  offset: Tick;
  points: readonly AutoPoint[];
  /** The automation channel's range (tempo clips), if any. */
  range?: { min: number; max: number };
}

/** All the spans that drive one target, sorted by where they start. */
export interface TargetAutomation {
  key: string;
  target: ParamTarget;
  /** Sorted by start. */
  spans: readonly AutoSpan[];
}

/** Every automated target of a project, by target key. */
export interface AutomationModel {
  readonly targets: ReadonlyMap<string, TargetAutomation>;
}

const EMPTY: AutomationModel = { targets: new Map() };
let last: { channels: object; playlist: object; model: AutomationModel } | null = null;

const sameSpans = (a: readonly AutoSpan[], b: readonly AutoSpan[]) =>
  a.length === b.length &&
  a.every(
    (s, i) =>
      s.clipId === b[i]!.clipId &&
      s.start === b[i]!.start &&
      s.end === b[i]!.end &&
      s.offset === b[i]!.offset &&
      s.points === b[i]!.points &&
      s.range?.min === b[i]!.range?.min &&
      s.range?.max === b[i]!.range?.max,
  );

/**
 * The automation model of a project, memoized on its channels and playlist. Targets whose spans
 * didn't change keep their previous TargetAutomation object (the engine reschedules only what changed).
 */
export function automationModelOf(p: Project): AutomationModel {
  if (last && last.channels === p.channels && last.playlist === p.playlist) return last.model;
  const muted = mutedLanes(p.playlist);
  const byKey = new Map<string, { target: ParamTarget; spans: AutoSpan[] }>();
  for (const c of clipsSorted(p.playlist.clips)) {
    if (c.kind !== 'automation' || c.muted || muted.has(c.laneId)) continue;
    const ch = p.channels[c.channelId];
    if (!ch || ch.kind !== 'automation' || ch.muted || !ch.target || ch.points.length === 0) continue;
    const key = targetKey(ch.target);
    let entry = byKey.get(key);
    if (!entry) byKey.set(key, (entry = { target: ch.target, spans: [] }));
    entry.spans.push(spanOf(c.id, ch, c.start, c.length, c.offset));
  }
  const prev = last?.model.targets;
  const targets = new Map<string, TargetAutomation>();
  for (const [key, { target, spans }] of byKey) {
    const old = prev?.get(key);
    targets.set(key, old && sameSpans(old.spans, spans) ? old : { key, target, spans });
  }
  const model = targets.size === 0 ? EMPTY : { targets };
  last = { channels: p.channels, playlist: p.playlist, model };
  return model;
}

function spanOf(clipId: ClipId, ch: AutomationChannel, start: Tick, length: Tick, offset: Tick): AutoSpan {
  return {
    clipId,
    channelId: ch.id,
    start,
    end: start + length,
    offset,
    points: ch.points,
    ...(ch.range ? { range: ch.range } : {}),
  };
}

/**
 * The span in effect at `tick` (inside a clip, or the last one that ended before it) and its
 * normalized value; null before the target's first clip (its document value applies).
 */
export function automationAt(ta: TargetAutomation, tick: Tick): { value: number; span: AutoSpan } | null {
  let inside: AutoSpan | null = null;
  let ended: AutoSpan | null = null;
  for (const s of ta.spans) {
    if (s.start > tick) break;
    if (tick < s.end)
      inside = s; // latest-starting containing span wins
    else if (!ended || s.end >= ended.end) ended = s;
  }
  const span = inside ?? ended;
  if (!span) return null;
  const local = (inside ? tick : span.end) - span.start + span.offset;
  const value = curveAt(span.points, local);
  return value === null ? null : { value, span };
}
