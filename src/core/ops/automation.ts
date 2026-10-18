/**
 * Draft mutators for automation clips: create one for a target, edit its points (add, move,
 * delete, shape, tension), replace them (LFO, recorded takes) and delete the automation. The points
 * live on the automation channel, so every clip of that channel shows the same curve.
 */
import type { Draft } from 'immer';
import { newId } from '../model/ids';
import { makeLane } from '../model/defaults';
import type {
  AutomationChannel,
  AutomationClip,
  AutoPoint,
  AutoShape,
  ChannelId,
  ClipId,
  LaneId,
  ParamTarget,
  Project,
  Tick,
} from '../model/types';
import { removeChannel } from './channels';

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** A point with an integer tick ≥ 0, a value in 0–1 and a valid tension (no default fields stored). */
export function sanitizePoint(p: AutoPoint): AutoPoint {
  const out: AutoPoint = { tick: Math.max(0, Math.round(p.tick)), value: clamp(p.value, 0, 1) };
  if (p.tension !== undefined && p.tension !== 0) out.tension = clamp(p.tension, -1, 1);
  if (p.shape !== undefined && p.shape !== 'curve') out.shape = p.shape;
  return out;
}

/** Sanitized and sorted by tick (equal ticks keep their order: a vertical jump). */
export function sanitizePoints(points: readonly AutoPoint[]): AutoPoint[] {
  return points
    .map((p, i) => ({ p: sanitizePoint(p), i }))
    .sort((a, b) => a.p.tick - b.p.tick || a.i - b.i)
    .map((x) => x.p);
}

/** The first lane (in order) with no clip overlapping [start, end), or null when every lane is busy. */
export function firstFreeLane(p: Project, start: Tick, end: Tick): LaneId | null {
  const busy = new Set<LaneId>();
  for (const c of Object.values(p.playlist.clips)) if (c.start < end && c.start + c.length > start) busy.add(c.laneId);
  // The comp and take tracks of a recording hold only that recording.
  return p.playlist.laneOrder.find((id) => !busy.has(id) && !p.playlist.lanes[id]?.takes) ?? null;
}

export interface CreateAutomationOptions {
  target: ParamTarget;
  /** Plain name, e.g. "Cutoff · 3xOsc" (see automationName). */
  name: string;
  color: string;
  /** Where the clip goes (song ticks). */
  start: Tick;
  length: Tick;
  /** The curve: default two points holding `value` (normalized 0–1) over the clip. */
  points?: readonly AutoPoint[];
  value?: number;
  /** Tempo clips: the BPM range the curve spans. */
  range?: { min: number; max: number };
  /** Default: the first free lane (a new lane at the bottom when none is free). */
  laneId?: LaneId;
  /** Fixed ids (gesture recipes must be repeatable). */
  ids?: { channel?: ChannelId; clip?: ClipId; lane?: LaneId };
}

/**
 * Adds an automation channel driving `target` and a clip playing it. Returns the new ids (the lane
 * is a new one when no lane was free).
 */
export function createAutomationClip(
  d: Draft<Project>,
  o: CreateAutomationOptions,
): { channelId: ChannelId; clipId: ClipId; laneId: LaneId } {
  const channelId = o.ids?.channel ?? newId.channel();
  const clipId = o.ids?.clip ?? newId.clip();
  const start = Math.max(0, Math.round(o.start));
  const length = Math.max(1, Math.round(o.length));
  const value = clamp(o.value ?? 0.5, 0, 1);
  const points = sanitizePoints(
    o.points ?? [
      { tick: 0, value },
      { tick: length, value },
    ],
  );
  const channel: AutomationChannel = {
    kind: 'automation',
    id: channelId,
    name: o.name.slice(0, 64) || 'Automation',
    color: o.color,
    muted: false,
    solo: false,
    target: o.target,
    points,
    ...(o.range ? { range: { ...o.range } } : {}),
  };
  d.channels[channelId] = channel as Draft<AutomationChannel>;
  if (!d.channelOrder.includes(channelId)) d.channelOrder.push(channelId);
  let laneId = o.laneId && d.playlist.lanes[o.laneId] ? o.laneId : firstFreeLane(d as Project, start, start + length);
  if (!laneId) {
    const lane = makeLane(`Track ${d.playlist.laneOrder.length + 1}`, o.ids?.lane);
    d.playlist.lanes[lane.id] = lane;
    d.playlist.laneOrder.push(lane.id);
    laneId = lane.id;
  }
  const clip: AutomationClip = { kind: 'automation', id: clipId, laneId, channelId, start, length, offset: 0 };
  d.playlist.clips[clipId] = clip;
  return { channelId, clipId, laneId };
}

function automationOf(d: Draft<Project>, id: ChannelId): Draft<AutomationChannel> | null {
  const ch = d.channels[id];
  return ch && ch.kind === 'automation' ? ch : null;
}

/** Replaces the curve (sanitized and sorted). */
export function setAutomationPoints(d: Draft<Project>, id: ChannelId, points: readonly AutoPoint[]): void {
  const ch = automationOf(d, id);
  if (ch) ch.points = sanitizePoints(points) as Draft<AutoPoint>[];
}

/** Inserts a point (after any points at the same tick) and returns its index (-1 when there's no such channel). */
export function addAutomationPoint(d: Draft<Project>, id: ChannelId, point: AutoPoint): number {
  const ch = automationOf(d, id);
  if (!ch) return -1;
  const p = sanitizePoint(point);
  let i = ch.points.length;
  while (i > 0 && (ch.points[i - 1] as AutoPoint).tick > p.tick) i--;
  ch.points.splice(i, 0, p as Draft<AutoPoint>);
  return i;
}

/** Moves a point; it stays between its neighbours (points keep their order). */
export function moveAutomationPoint(d: Draft<Project>, id: ChannelId, index: number, tick: Tick, value: number): void {
  const ch = automationOf(d, id);
  const p = ch?.points[index];
  if (!ch || !p) return;
  const lo = ch.points[index - 1]?.tick ?? 0;
  const hi = ch.points[index + 1]?.tick ?? Number.MAX_SAFE_INTEGER;
  p.tick = clamp(Math.round(tick), lo, hi);
  p.value = clamp(value, 0, 1);
}

/** Deletes a point (a curve keeps at least one). */
export function removeAutomationPoint(d: Draft<Project>, id: ChannelId, index: number): void {
  const ch = automationOf(d, id);
  if (!ch || ch.points.length <= 1 || !ch.points[index]) return;
  ch.points.splice(index, 1);
}

/** The shape of the segment leaving point `index`. */
export function setAutomationPointShape(d: Draft<Project>, id: ChannelId, index: number, shape: AutoShape): void {
  const p = automationOf(d, id)?.points[index];
  if (!p) return;
  if (shape === 'curve') delete p.shape;
  else p.shape = shape;
}

/** The bend of the segment leaving point `index` (−1…1, 0 = straight). */
export function setAutomationPointTension(d: Draft<Project>, id: ChannelId, index: number, tension: number): void {
  const p = automationOf(d, id)?.points[index];
  if (!p) return;
  const t = clamp(tension, -1, 1);
  if (Math.abs(t) < 1e-3) delete p.tension;
  else p.tension = t;
}

/** Deletes an automation channel and all its clips. */
export function removeAutomation(d: Draft<Project>, id: ChannelId): void {
  if (automationOf(d, id)) removeChannel(d, id);
}
