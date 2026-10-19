import type { Draft } from 'immer';
import { resolveTarget } from '../../automation/targets';
import { newId } from '../../model/ids';
import { paletteColor } from '../../model/defaults';
import { targetKey } from '../../model/targets';
import {
  MASTER,
  type AutomationChannel,
  type AutomationClip,
  type AutoPoint,
  type ChannelId,
  type ClipId,
  type ParamTarget,
  type Project,
  type Tick,
} from '../../model/types';
import { addClips } from '../../ops/playlist';
import type { PlannedAutomation } from '../plan';
import type { AutomationItem, AutomationPurpose, AutomationTarget } from '../transitions';
import { laneNamed } from './lanes';
import type { ApplyEnv, SweepTargets } from './types';

/** The EQ Pro parameter each sweep moves. */
const EQ_BAND: Record<'low-cut' | 'high-cut', string> = { 'low-cut': 'b1Freq', 'high-cut': 'b8Freq' };

const PURPOSE_LABEL: Record<AutomationPurpose, string> = {
  'sweep-up': 'Sweep up',
  'filter-open': 'Filter open',
  'intro-open': 'Intro filter',
  throw: 'Reverb throw',
  fade: 'Fade out',
};

/** Automation channels the arranger names (only those are removed when nothing plays them). */
export const ARRANGER_AUTOMATION = /^(Sweep up|Filter open|Intro filter|Reverb throw|Fade out) · /;

/** The colour of the arranger's automation channels (a palette slot). */
const AUTOMATION_COLOR_SLOT = 9;
/** A reverb throw opens the send this far above where it sits (dB), at least −3 dB, never above 0 dB. */
const THROW_BOOST_DB = 10;
const THROW_MIN_DB = -3;
/** Where a send at zero gain counts as sitting (dB). */
const SILENT_SEND_DB = -60;
/** A sweep up always goes at least this much past where the control sits. */
const SWEEP_UP_MIN_FACTOR = 2;
const FOUR_BEAT_BAR_TICKS = 960 * 4;

/** The concrete control a curve moves, or null when the song has no such control. */
export function resolveAutomationTarget(t: AutomationTarget, targets: SweepTargets): ParamTarget | null {
  if (t.kind === 'master') return { kind: 'insert', insertId: MASTER, param: 'volume' };
  if (t.kind === 'throw') {
    return targets.throw ? { kind: 'route', insertId: targets.throw.from, to: targets.throw.to } : null;
  }
  const bus = targets[t.bus];
  if (!bus) return null;
  return {
    kind: 'plugin',
    owner: { kind: 'fx', insertId: bus.insertId, slotId: bus.slotId },
    paramId: EQ_BAND[t.band],
  };
}

/**
 * What a curve moves, for its name: the channel or two that play through the swept bus ("Pad", "Arp + Lead"), else the bus's own name
 * ("Chords"), else the generic one.
 */
function busName(p: Project, t: AutomationTarget, targets: SweepTargets): string {
  if (t.kind === 'master') return 'Master';
  const insertId = t.kind === 'throw' ? targets.throw?.from : targets[t.bus]?.insertId;
  const insert = insertId ? p.mixer.inserts[insertId] : undefined;
  if (!insertId || !insert) return t.kind === 'eq' && t.bus !== 'chords' ? 'Lead' : 'Chords';
  const names = p.channelOrder.flatMap((cid) => {
    const ch = p.channels[cid];
    return ch && ch.kind !== 'automation' && ch.output === insertId ? [ch.name] : [];
  });
  return names.length >= 1 && names.length <= 2 ? names.join(' + ') : insert.name;
}

type ResolvedTarget = NonNullable<ReturnType<typeof resolveTarget>>;

/** One point value as a normalized control value: 'neutral' = where the control sits, 'throw' = a send boost. */
function pointValue(value: number | 'neutral' | 'throw', item: AutomationItem, res: ResolvedTarget): number {
  if (value === 'neutral') return res.toNormalized(res.base);
  if (value === 'throw') {
    const base = res.base;
    const db = base > 0 ? 20 * Math.log10(base) : SILENT_SEND_DB;
    return res.toNormalized(Math.min(1, Math.pow(10, Math.max(db + THROW_BOOST_DB, THROW_MIN_DB) / 20)));
  }
  if (item.purpose === 'sweep-up') return res.toNormalized(Math.max(value, res.base * SWEEP_UP_MIN_FACTOR));
  if (item.purpose === 'filter-open' || item.purpose === 'intro-open')
    return res.toNormalized(Math.min(value, res.base));
  return res.toNormalized(value);
}

/** A curve's points normalized for its control ('neutral' = where the control sits). */
export function automationPoints(item: AutomationItem, res: ResolvedTarget): AutoPoint[] {
  return item.points.map((pt) => ({
    tick: Math.round(pt.at),
    value: Math.min(1, Math.max(0, pointValue(pt.value, item, res))),
    ...(pt.tension ? { tension: pt.tension } : {}),
  }));
}

const samePoints = (a: readonly AutoPoint[], b: readonly AutoPoint[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.tick === b[i]!.tick &&
      Math.abs(x.value - b[i]!.value) < 1e-9 &&
      (x.tension ?? 0) === (b[i]!.tension ?? 0) &&
      (x.shape ?? 'curve') === (b[i]!.shape ?? 'curve'),
  );

/** Whether an unmuted automation clip already moves the control `key` somewhere in [from, to). */
function automationBusy(p: Project, key: string, from: Tick, to: Tick): boolean {
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'automation' || c.muted || c.start >= to || c.start + c.length <= from) continue;
    const ch = p.channels[c.channelId];
    if (ch?.kind === 'automation' && ch.target && targetKey(ch.target) === key) return true;
  }
  return false;
}

/** The channel that already holds exactly these points for this control, if any (the last one wins). */
function findCurveChannel(
  p: Project,
  d: Draft<Project>,
  key: string,
  points: readonly AutoPoint[],
): ChannelId | undefined {
  let found: ChannelId | undefined;
  for (const cid of d.channelOrder) {
    const ch = p.channels[cid];
    if (ch?.kind === 'automation' && ch.target && targetKey(ch.target) === key && samePoints(ch.points, points))
      found = cid;
  }
  return found;
}

/** "Sweep up · Pad (2 bars)": what the curve is and what it moves. */
function curveName(p: Project, item: PlannedAutomation, targets: SweepTargets): string {
  const base = `${PURPOSE_LABEL[item.purpose]} · ${busName(p, item.target, targets)}`;
  if (item.purpose === 'throw') return base;
  const bars = Math.round((item.length / FOUR_BEAT_BAR_TICKS) * 100) / 100;
  return `${base} (${bars} bar${bars === 1 ? '' : 's'})`;
}

/**
 * Places curves (one automation channel per purpose, control and length, reused); skips controls
 * that don't exist, and with `skipBusy` controls already automated there.
 */
export function placeAutomation(
  d: Draft<Project>,
  items: readonly PlannedAutomation[],
  env: ApplyEnv,
  opts: { skipBusy?: boolean } = {},
): ClipId[] {
  const p = d as unknown as Project;
  const out: ClipId[] = [];
  for (const item of items) {
    const target = resolveAutomationTarget(item.target, env.targets);
    if (!target) continue;
    const res = resolveTarget(p, target, env.specsOf);
    if (!res) continue;
    const points = automationPoints(item, res);
    const key = targetKey(target);
    if (opts.skipBusy && automationBusy(p, key, item.start, item.start + item.length)) continue;
    let channelId = findCurveChannel(p, d, key, points);
    if (!channelId) {
      const channel: AutomationChannel = {
        kind: 'automation',
        id: newId.channel(),
        name: curveName(p, item, env.targets),
        color: paletteColor(AUTOMATION_COLOR_SLOT),
        muted: false,
        solo: false,
        target,
        points,
      };
      d.channels[channel.id] = channel as Draft<AutomationChannel>;
      d.channelOrder.push(channel.id);
      channelId = channel.id;
    }
    const clip: AutomationClip = {
      kind: 'automation',
      id: newId.clip(),
      laneId: laneNamed(d, item.lane),
      start: Math.max(0, Math.round(item.start)),
      length: Math.max(1, Math.round(item.length)),
      channelId,
      offset: 0,
    };
    addClips(d, [clip]);
    out.push(clip.id);
  }
  return out;
}
