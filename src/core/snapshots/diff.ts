/**
 * "What is different": a readable list of the changes between two mixer states, in plain words with units
 * ("Kick: fader -3.0 dB → -5.5 dB"). `diffAgainstCurrent` answers "what would recalling this snapshot change?".
 */
import { formatValue, type ParamValue } from '@agstudio/sdk/params';
import type { PluginInfoResolver } from '../automation/labels';
import { formatGain } from '../model/fader';
import { BRANCH_LEVEL_MIN_DB } from '../model/rack';
import type {
  BranchId,
  GroupId,
  InsertId,
  MixSnapshot,
  Project,
  SlotId,
  SnapshotInsert,
  SnapshotRack,
  SnapshotRouting,
  SnapshotSlot,
} from '../model/types';
import { captureMixerState, type MixerState } from './capture';

/** One difference: the track it is about (null for the mix as a whole) and the sentence that says it. */
export interface MixDifference {
  insertId: InsertId | null;
  text: string;
}

/** Numbers closer than this count as equal (levels are stored as doubles; a drag never lands this near). */
const SAME_WITHIN = 1e-9;

const isSame = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < SAME_WITHIN : a === b;

/** "Centre", "40% left", "100% right". */
export function formatPan(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  return percent === 0 ? 'centre' : `${percent}% ${pan < 0 ? 'left' : 'right'}`;
}

/** The names a difference sentence needs: tracks by id (also deleted ones, from the states) and plugins. */
interface Names {
  track(id: InsertId): string;
  plugins: PluginInfoResolver;
}

function describeSwitch(isOn: boolean, onText: string, offText: string): string {
  return isOn ? onText : offText;
}

function insertDifferences(id: InsertId, from: SnapshotInsert, to: SnapshotInsert, names: Names): MixDifference[] {
  const track = names.track(id);
  const out: MixDifference[] = [];
  const say = (text: string) => out.push({ insertId: id, text: `${track}: ${text}` });
  if (!isSame(from.volume, to.volume)) say(`fader ${formatGain(from.volume)} → ${formatGain(to.volume)}`);
  if (!isSame(from.pan, to.pan)) say(`pan ${formatPan(from.pan)} → ${formatPan(to.pan)}`);
  if (from.muted !== to.muted) say(`${describeSwitch(from.muted, 'muted', 'playing')} → ${describeSwitch(to.muted, 'muted', 'playing')}`);
  if (from.solo !== to.solo) say(`${describeSwitch(from.solo, 'soloed', 'not soloed')} → ${describeSwitch(to.solo, 'soloed', 'not soloed')}`);
  for (const [target, level] of Object.entries(to.sends) as [InsertId, number][]) {
    const before = from.sends[target];
    if (before !== undefined && !isSame(before, level)) {
      say(`send to ${names.track(target)} ${formatGain(before)} → ${formatGain(level)}`);
    }
  }
  return out.concat(slotDifferences(id, from, to, names));
}

function slotLabel(id: InsertId, slot: SnapshotSlot, names: Names): string {
  return `${names.track(id)} · ${names.plugins(slot.plugin)?.name ?? 'Effect'}`;
}

function slotDifferences(id: InsertId, from: SnapshotInsert, to: SnapshotInsert, names: Names): MixDifference[] {
  const out: MixDifference[] = [];
  for (const [slotId, after] of Object.entries(to.fx) as [SlotId, SnapshotSlot][]) {
    const before = from.fx[slotId];
    const label = slotLabel(id, after, names);
    if (!before) {
      out.push({ insertId: id, text: `${label}: not on the track now (the snapshot's settings for it are skipped)` });
      continue;
    }
    if (before.enabled !== after.enabled) {
      out.push({ insertId: id, text: `${label}: ${describeSwitch(before.enabled, 'on', 'bypassed')} → ${describeSwitch(after.enabled, 'on', 'bypassed')}` });
    }
    if (!isSame(before.mix, after.mix)) {
      out.push({ insertId: id, text: `${label}: dry/wet ${Math.round(before.mix * 100)}% → ${Math.round(after.mix * 100)}%` });
    }
    if (before.plugin === after.plugin) out.push(...paramDifferences(id, label, before, after, names));
    if (before.rack && after.rack) out.push(...rackDifferences(id, label, before.rack, after.rack));
  }
  for (const slotId of Object.keys(from.fx) as SlotId[]) {
    const added = from.fx[slotId]!;
    if (!to.fx[slotId]) out.push({ insertId: id, text: `${slotLabel(id, added, names)}: added since the snapshot (left as it is)` });
  }
  return out;
}

function paramDifferences(id: InsertId, label: string, before: SnapshotSlot, after: SnapshotSlot, names: Names): MixDifference[] {
  const specs = names.plugins(after.plugin)?.params;
  const out: MixDifference[] = [];
  for (const [key, value] of Object.entries(after.params)) {
    const old = before.params[key];
    if (old === undefined || isSame(old, value)) continue;
    const spec = specs?.[key];
    const show = (v: ParamValue) => (spec ? formatValue(spec, v) : String(v));
    out.push({ insertId: id, text: `${label}: ${spec?.label ?? key} ${show(old)} → ${show(value)}` });
  }
  return out;
}

/** What differs in a rack's branches (level, pan, mute, solo) and crossovers. */
function rackDifferences(id: InsertId, label: string, before: SnapshotRack, after: SnapshotRack): MixDifference[] {
  const out: MixDifference[] = [];
  const say = (text: string) => out.push({ insertId: id, text: `${label}: ${text}` });
  for (const [branchId, now] of Object.entries(after.branches) as [BranchId, SnapshotRack['branches'][BranchId]][]) {
    const old = before.branches[branchId];
    if (!old) continue;
    if (!isSame(old.levelDb, now.levelDb)) say(`${now.name} level ${formatDb(old.levelDb)} → ${formatDb(now.levelDb)}`);
    if (!isSame(old.pan, now.pan)) say(`${now.name} pan ${formatPan(old.pan)} → ${formatPan(now.pan)}`);
    if (old.muted !== now.muted) say(`${now.name} ${describeSwitch(old.muted, 'muted', 'playing')} → ${describeSwitch(now.muted, 'muted', 'playing')}`);
    if (old.solo !== now.solo) say(`${now.name} ${describeSwitch(old.solo, 'soloed', 'not soloed')} → ${describeSwitch(now.solo, 'soloed', 'not soloed')}`);
  }
  after.crossovers.forEach((hz, index) => {
    const old = before.crossovers[index];
    if (old !== undefined && !isSame(old, hz)) say(`crossover ${index + 1} ${Math.round(old)} Hz → ${Math.round(hz)} Hz`);
  });
  return out;
}

/** "−6.0 dB" for a branch level (−60 reads as "off"). */
function formatDb(db: number): string {
  return db <= BRANCH_LEVEL_MIN_DB ? 'off' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function routeList(routing: SnapshotRouting, names: Names): string {
  const targets = routing.routes.map((route) => names.track(route.to) + (route.pre ? ' (pre-fader)' : ''));
  return targets.length ? targets.join(', ') : 'nothing';
}

function routingDifferences(id: InsertId, from: MixerState, to: MixerState, names: Names): MixDifference[] {
  const before = from.routing?.[id];
  const after = to.routing?.[id];
  if (!before || !after) return [];
  const out: MixDifference[] = [];
  const beforeText = routeList(before, names);
  const afterText = routeList(after, names);
  if (beforeText !== afterText) out.push({ insertId: id, text: `${names.track(id)}: sends to ${beforeText} → ${afterText}` });
  for (const [slotId, source] of Object.entries(after.sidechains) as [SlotId, InsertId | null][]) {
    if (!(slotId in before.sidechains) || before.sidechains[slotId] === source) continue;
    const text = (from: InsertId | null) => (from ? names.track(from) : 'its own input');
    out.push({ insertId: id, text: `${names.track(id)}: sidechain ${text(before.sidechains[slotId] ?? null)} → ${text(source)}` });
  }
  return out;
}

/** The names a diff uses: the live project's track names, else the names the states kept. */
function namesFor(project: Project, states: readonly MixerState[], plugins: PluginInfoResolver): Names {
  return {
    plugins,
    track(id) {
      const live = project.mixer.inserts[id]?.name;
      if (live) return live;
      for (const state of states) if (state.inserts[id]) return state.inserts[id].name;
      return 'a deleted track';
    },
  };
}

function vcaDifferences(project: Project, from: MixerState, to: MixerState): MixDifference[] {
  const out: MixDifference[] = [];
  for (const [groupId, level] of Object.entries(to.vca ?? {}) as [GroupId, number][]) {
    const before = from.vca?.[groupId];
    if (before === undefined || isSame(before, level)) continue;
    const name = project.mixer.groups?.find((group) => group.id === groupId)?.name ?? 'a group';
    out.push({ insertId: null, text: `VCA of ${name}: ${formatGain(before)} → ${formatGain(level)}` });
  }
  return out;
}

/**
 * The differences from state `from` to state `to`, tracks in mixer order. A track in only one of them is said once;
 * recalling `to` skips one that was deleted and leaves one that `to` does not know alone.
 */
export function diffMixerStates(
  project: Project,
  from: MixerState,
  to: MixerState,
  plugins: PluginInfoResolver,
): MixDifference[] {
  const names = namesFor(project, [from, to], plugins);
  const ids = new Set<InsertId>([...project.mixer.order, ...(Object.keys(to.inserts) as InsertId[]), ...(Object.keys(from.inserts) as InsertId[])]);
  const out: MixDifference[] = [];
  for (const id of ids) {
    const before = from.inserts[id];
    const after = to.inserts[id];
    if (before && after) {
      out.push(...insertDifferences(id, before, after, names), ...routingDifferences(id, from, to, names));
    } else if (after) {
      const isGone = !project.mixer.inserts[id];
      const note = isGone ? 'deleted since (its saved settings are skipped)' : 'only in the snapshot';
      out.push({ insertId: id, text: `${names.track(id)}: ${note}` });
    } else if (before) {
      out.push({ insertId: id, text: `${names.track(id)}: not in the snapshot (left as it is)` });
    }
  }
  return out.concat(vcaDifferences(project, from, to));
}

/** What recalling the snapshot would change in the mix as it is now (empty: the mix already matches it). */
export function diffAgainstCurrent(project: Project, snapshot: MixSnapshot, plugins: PluginInfoResolver): MixDifference[] {
  const current = captureMixerState(project, { routing: !!snapshot.routing });
  return diffMixerStates(project, current, snapshot, plugins);
}

/** What switching from snapshot `a` to snapshot `b` changes. */
export function diffBetween(project: Project, a: MixSnapshot, b: MixSnapshot, plugins: PluginInfoResolver): MixDifference[] {
  return diffMixerStates(project, a, b, plugins);
}
