/**
 * edit_automation: changes the points of an automation channel that already has clips, in place.
 * Bars count from the start of the curve (0 = its first bar), as get_automation reports them; values
 * are in the control's unit. Everything is checked first (focus, clip overlaps, a curve left with no
 * points), then written, so a refused edit changes nothing.
 *
 * The curve is shared by every clip of the channel, so an edit reaches the stretch from the untouched
 * point before its range to the one after it, in every clip that plays that stretch. Clips grow when
 * the curve now runs past their end, and the part's focus guard sees each song stretch that changes,
 * including the held value a clip leaves behind when the curve's value at its end moves.
 */
import { curveAt } from '@core/automation/curve';
import { targetName } from '@core/automation/labels';
import { resolveTarget, type ResolvedTarget } from '@core/automation/targets';
import type {
  AutomationChannel,
  AutomationClip,
  AutoPoint,
  AutoShape,
  Clip,
  ParamTarget,
  Tick,
} from '@core/model/types';
import { sanitizePoints, setAutomationPoints } from '@core/ops/automation';
import type { ParamSpecs } from '@agstudio/sdk';
import type { Draft } from 'immer';
import type { AiAction } from '../../schema';
import { fail, type OpContext } from '../context';
import { isObj, lower, num, r2, str } from '../values';
import { normalizedOf, ownUnitOf, automationDrives, pluginInfoOf } from './targets';

/** The ways edit_automation can change points. */
export const EDIT_MODES = ['set_points', 'move', 'scale', 'remove', 'tension'] as const;
type EditMode = (typeof EDIT_MODES)[number];

/** Curve shapes a point can ask for (a plain curve is the default and is not stored). */
const POINT_SHAPES = ['curve', 'hold', 'stairs', 'smooth'] as const;
/** A held value that moved by less than this (0–1) is not a change. */
const HELD_VALUE_EPSILON = 1e-6;

/** A point the AI wrote, at a tick, with the shape and tension it asked for (as automate reads them). */
export function pointFrom(written: Record<string, unknown>, tick: Tick, value: number): AutoPoint {
  const shape = POINT_SHAPES.find((candidate) => candidate === str(written.shape));
  const tension = num(written.tension);
  return {
    tick,
    value,
    ...(shape && shape !== 'curve' ? { shape: shape as AutoShape } : {}),
    ...(tension !== undefined && tension !== 0 ? { tension: Math.min(1, Math.max(-1, tension)) } : {}),
  };
}

/** The automation channel an edit names: by id, exact name or @ref, or by what it drives (as get_automation reports it). */
function automationChannelOf(context: OpContext, action: AiAction): AutomationChannel {
  const { draft, services, project } = context;
  if (action.channel !== undefined) {
    const id = context.channel(action.channel);
    const channel = draft.channels[id];
    if (channel?.kind !== 'automation') fail(`“${channel?.name ?? id}” is not an automation channel`);
    return project.channels[id] as AutomationChannel;
  }
  const drives =
    str(action.drives) ?? fail('which automation? give its channel, or what it drives (as get_automation reports it)');
  const matches = project.channelOrder
    .map((id) => project.channels[id]!)
    .filter(
      (channel): channel is AutomationChannel =>
        channel.kind === 'automation' && lower(automationDrives(services, project, channel)) === lower(drives),
    );
  if (matches.length === 0) fail(`nothing drives “${drives}”`);
  if (matches.length > 1) {
    fail(`${matches.length} automation channels drive “${drives}”; give the one to change by its channel`);
  }
  return matches[0]!;
}

/** What one edit works on. */
interface Edit {
  action: AiAction;
  context: OpContext;
  channel: AutomationChannel;
  /** The range of the curve the edit is about, in bars from the curve start (`to` undefined: to the end). */
  fromBar: number;
  toBar: number | undefined;
  /** The same range in ticks (`hi` is Infinity without `toBar`). */
  lo: Tick;
  hi: Tick;
  /** "bars 2–4", "the whole curve": the range in words. */
  rangeText: string;
  /** What the channel drives, for messages. */
  name: string;
  ticksPerBar: Tick;
  /** The curve before the edit, the points in the range, and the points outside it. */
  old: AutoPoint[];
  edited: AutoPoint[];
  untouched: AutoPoint[];
  /** The control and how to read its values; fails when the channel drives nothing that exists. */
  control(): { resolved: ResolvedTarget; target: ParamTarget };
}

/** What an edit writes: the points at their new positions, the whole curve after it, and the chat line. */
interface EditPlan {
  touchedNew: AutoPoint[];
  next: AutoPoint[];
  line: string;
}

const count = (n: number) => `${n} point${n === 1 ? '' : 's'}`;

function describeRange(fromBar: number, toBar: number | undefined): string {
  if (toBar !== undefined) return `bars ${r2(fromBar)}–${r2(toBar)}`;
  return fromBar === 0 ? 'the whole curve' : `bar ${r2(fromBar)} on`;
}

/** Works out the range, the control and the points an edit is about (failing for a refused request). */
function openEdit(action: AiAction, context: OpContext): { edit: Edit; mode: EditMode } {
  const { services, project } = context;
  const mode =
    EDIT_MODES.find((candidate) => candidate === str(action.mode)) ??
    fail(`unknown mode "${String(action.mode)}" (set_points, move, scale, remove or tension)`);
  const channel = automationChannelOf(context, action);
  const ticksPerBar = context.bar();
  const fromBar = Math.max(0, num(action.from) ?? 0);
  const toBar = num(action.to);
  if (toBar !== undefined && toBar <= fromBar) {
    fail(`the range ends at bar ${r2(toBar)}, before it starts (bar ${r2(fromBar)})`);
  }
  const lo = Math.round(fromBar * ticksPerBar);
  const hi = toBar === undefined ? Infinity : Math.round(toBar * ticksPerBar);
  const isInRange = (point: AutoPoint) => point.tick >= lo && point.tick < hi;
  const name = (channel.target && targetName(project, channel.target, pluginInfoOf(services))) || channel.name;
  const rangeText = describeRange(fromBar, toBar);
  // Values need the control; it must still exist.
  const resolved = channel.target
    ? resolveTarget(
        project,
        channel.target,
        (pluginId) => services.plugins.get(pluginId)?.params as ParamSpecs | undefined,
        channel.range,
      )
    : null;
  const control = () => {
    if (channel.target && resolved) return { resolved, target: channel.target };
    const why = channel.target ? 'the control it drives no longer exists' : 'it drives nothing';
    return fail(`${name} can't be edited: ${why}`);
  };
  const old: AutoPoint[] = channel.points.map((point) => ({ ...point }));
  const edited = old.filter(isInRange);
  const untouched = old.filter((point) => !isInRange(point));
  if (mode !== 'set_points' && edited.length === 0) fail(`no points in ${rangeText}`);
  const edit: Edit = {
    action,
    context,
    channel,
    fromBar,
    toBar,
    lo,
    hi,
    rangeText,
    name,
    ticksPerBar,
    old,
    edited,
    untouched,
    control,
  };
  return { edit, mode };
}

/** set_points: the points given replace the points in the range. */
function setPoints(edit: Edit): EditPlan {
  const { action, context, untouched, fromBar, toBar, rangeText, name, ticksPerBar } = edit;
  const { resolved, target } = edit.control();
  const written = Array.isArray(action.points) ? action.points.filter(isObj) : [];
  if (written.length === 0) fail('set_points needs points: a bar and a value (in the control’s unit) for each');
  const fresh: AutoPoint[] = [];
  for (const point of written) {
    const value = normalizedOf(resolved, target, point.value);
    const bar = num(point.bar);
    if (value === null || bar === undefined) {
      context.warn(`automation point ${JSON.stringify(point)} skipped`);
      continue;
    }
    if (bar < fromBar || (toBar !== undefined && bar >= toBar)) {
      context.warn(`automation point at bar ${r2(bar)} is outside ${rangeText}, skipped`);
      continue;
    }
    if (value < 0 || value > 1) {
      context.warn(`${JSON.stringify(point.value)} is past the range of ${name}; kept at its edge`);
    }
    fresh.push(pointFrom(point, Math.max(0, Math.round(bar * ticksPerBar)), value));
  }
  if (fresh.length === 0) fail(`none of the points is in ${rangeText}`);
  return { touchedNew: fresh, next: [...untouched, ...fresh], line: `set ${count(fresh.length)} in ${rangeText}` };
}

/** move: shifts the points in the range by some bars. */
function movePoints(edit: Edit): EditPlan {
  const { action, context, edited, untouched, ticksPerBar } = edit;
  const bars = num(action.by) ?? fail('move needs by: how many bars to shift the points (negative = earlier)');
  const shift = Math.round(bars * ticksPerBar);
  let movedBeforeStart = 0;
  const touchedNew = edited.map((point) => {
    const tick = point.tick + shift;
    if (tick < 0) movedBeforeStart++;
    return { ...point, tick: Math.max(0, tick) };
  });
  if (movedBeforeStart) {
    context.warn(`${count(movedBeforeStart)} would move before the start of the curve; kept at bar 0`);
  }
  const sign = bars > 0 ? '+' : '';
  const plural = Math.abs(bars) === 1 ? '' : 's';
  return {
    touchedNew,
    next: [...untouched, ...touchedNew],
    line: `moved ${count(edited.length)} by ${sign}${r2(bars)} bar${plural}`,
  };
}

const SCALE_NEEDS_FACTOR =
  'scale needs factor: 0 or more (2 doubles how far the points sit from their middle, 0.5 halves it)';

/** scale: multiplies how far the points sit from their middle. */
function scalePoints(edit: Edit): EditPlan {
  const { action, context, edited, untouched, name } = edit;
  const { resolved, target } = edit.control();
  const factor = num(action.factor) ?? fail(SCALE_NEEDS_FACTOR);
  if (factor < 0) fail(SCALE_NEEDS_FACTOR);
  const ownValues = edited.map((point) => ownUnitOf(resolved, target, point.value));
  if (!ownValues.every((value): value is number => typeof value === 'number')) {
    fail(`${name} holds choices, not numbers, so it can't be scaled`);
  }
  const numbers = ownValues as number[];
  const middle = (Math.min(...numbers) + Math.max(...numbers)) / 2;
  let pastTheRange = 0;
  const touchedNew = edited.map((point, index) => {
    const value = normalizedOf(resolved, target, middle + (numbers[index]! - middle) * factor) ?? point.value;
    if (value < 0 || value > 1) pastTheRange++;
    return { ...point, value: Math.min(1, Math.max(0, value)) };
  });
  if (pastTheRange) context.warn(`${count(pastTheRange)} went past the range of ${name}; kept at its edge`);
  return {
    touchedNew,
    next: [...untouched, ...touchedNew],
    line: `scaled ${count(edited.length)} around their middle (×${r2(factor)})`,
  };
}

/** remove: deletes the points in the range (a curve keeps at least one). */
function removePoints(edit: Edit): EditPlan {
  const { edited, untouched } = edit;
  if (untouched.length === 0) {
    fail(`removing ${count(edited.length)} would leave the curve with no points; a curve keeps at least one`);
  }
  return { touchedNew: [], next: untouched, line: `removed ${count(edited.length)}` };
}

/** tension: sets the bend of the curve leaving the points in the range. */
function setTension(edit: Edit): EditPlan {
  const { action, edited, untouched } = edit;
  const tension =
    num(action.tension) ?? fail('tension needs tension: −1…1 (negative starts the move slowly, positive starts fast)');
  const bend = Math.min(1, Math.max(-1, tension));
  const touchedNew = edited.map((point) => ({ ...point, tension: bend }));
  return {
    touchedNew,
    next: [...untouched, ...touchedNew],
    line: `set the tension of ${count(edited.length)} to ${r2(bend)}`,
  };
}

const PLANNERS: Record<EditMode, (edit: Edit) => EditPlan> = {
  set_points: setPoints,
  move: movePoints,
  scale: scalePoints,
  remove: removePoints,
  tension: setTension,
};

/** What the edit does to the song, clip by clip: which clips grow and which stretches of the song change. */
interface SongEffects {
  grow: { clip: AutomationClip; length: number }[];
  touchedSpans: { from: Tick; to: Tick; clip: AutomationClip }[];
}

/**
 * Checks every clip of the channel against the new curve (growing past its end must not run into another clip) and tells
 * the focus guard each song stretch that changes. Nothing is written yet.
 */
function songEffectsOf(edit: Edit, plan: EditPlan): SongEffects {
  const { context, channel, old, edited, lo, hi, ticksPerBar } = edit;
  const { project } = context;
  // The curve as it will be stored, and the content stretch that can change: from the untouched point
  // before the range to the one after it (a curve's segments reach both ways), plus anything written.
  const after = sanitizePoints(plan.next);
  const previousTick = old.filter((point) => point.tick < lo).at(-1)?.tick ?? 0;
  const nextTick = old.find((point) => point.tick >= hi)?.tick ?? Infinity;
  const writtenTicks = [...edited, ...plan.touchedNew].map((point) => point.tick);
  const changedFrom = Math.min(previousTick, ...writtenTicks);
  const changedTo = Math.max(nextTick, ...writtenTicks.map((tick) => tick + 1));
  const lastTick = after.at(-1)?.tick ?? 0;

  const allClips = Object.values(project.playlist.clips) as Clip[];
  const clips = allClips.filter(
    (clip): clip is AutomationClip => clip.kind === 'automation' && clip.channelId === channel.id,
  );
  const effects: SongEffects = { grow: [], touchedSpans: [] };
  for (const clip of clips) {
    const contentEnd = clip.offset + clip.length;
    const length =
      lastTick > contentEnd ? Math.ceil((lastTick - clip.offset) / ticksPerBar) * ticksPerBar : clip.length;
    const newEnd = clip.offset + length;
    const songTick = (contentTick: number) => clip.start + contentTick - clip.offset;
    if (length > clip.length) {
      const songEnd = clip.start + length;
      const clash = allClips.find(
        (other) =>
          other.id !== clip.id &&
          other.laneId === clip.laneId &&
          other.start < songEnd &&
          other.start + other.length > clip.start + clip.length,
      );
      if (clash) {
        const track = project.playlist.laneOrder.indexOf(clip.laneId) + 1;
        fail(
          `the curve runs on past the end of its clip (bar ${r2(songTick(contentEnd) / ticksPerBar + 1)}), into another clip on track ${track}`,
        );
      }
      effects.grow.push({ clip, length });
    }
    const from = Math.max(changedFrom, clip.offset);
    const to = Math.min(changedTo, newEnd);
    if (from < to) {
      context.focus.span(songTick(from), songTick(to), 'edit_automation');
      effects.touchedSpans.push({ from: songTick(from), to: songTick(to), clip });
    }
    if (length > clip.length && !(from <= contentEnd && to >= newEnd)) {
      context.focus.span(songTick(contentEnd), songTick(newEnd), 'edit_automation');
      effects.touchedSpans.push({ from: songTick(contentEnd), to: songTick(newEnd), clip });
    }
    // The value the clip leaves behind holds on after it, until something else plays: a change there reaches the rest of the song.
    const heldBefore = curveAt(old, contentEnd);
    const heldAfter = curveAt(after, newEnd);
    if (heldBefore !== null && heldAfter !== null && Math.abs(heldBefore - heldAfter) > HELD_VALUE_EPSILON) {
      context.focus.span(songTick(newEnd), Infinity, 'edit_automation');
    }
  }
  return effects;
}

/** edit_automation: see the file comment. Returns the chat line. */
export function editAutomation(action: AiAction, context: OpContext): string {
  const { draft } = context;
  const { edit, mode } = openEdit(action, context);
  const plan = PLANNERS[mode](edit);
  const effects = songEffectsOf(edit, plan);
  setAutomationPoints(draft, edit.channel.id, plan.next);
  for (const { clip, length } of effects.grow) {
    (draft.playlist.clips[clip.id] as Draft<AutomationClip>).length = length;
  }
  for (const span of effects.touchedSpans) context.touch(span.from, span.to, [span.clip.id]);
  return `${edit.name}: ${plan.line}`;
}
