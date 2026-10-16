/** Automation clips: a control moving over time (points or an LFO). */
import { LFO_SHAPES, lfoPoints, type LfoShape } from '@core/automation/generate';
import { curveAt } from '@core/automation/curve';
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget, TEMPO_RANGE, type ResolvedTarget } from '@core/automation/targets';
import { gainToDecibels } from '@core/model/fader';
import { paletteColor } from '@core/model/defaults';
import type {
  AutomationChannel,
  AutomationClip,
  AutoPoint,
  AutoShape,
  Clip,
  ParamTarget,
  PluginOwner,
  Project,
  Tick,
} from '@core/model/types';
import { createAutomationClip, sanitizePoints, setAutomationPoints } from '@core/ops/automation';
import { PPQ } from '@core/time/ppq';
import { dbToGain, decode, encode, isAutomatable, type ParamSpecs } from '@agstudio/sdk';
import type { Draft } from 'immer';
import { tempoRange } from '../../automation';
import type { Services } from '../../services';
import * as S from '../schema/parts';
import type { AiAction } from '../schema';
import { fail, type OpContext, type OpModule } from './context';
import { coerceParam, findParamId, isObj, lower, num, r2, str } from './values';

/** One curve point as the AI writes it (the same fields for automate and edit_automation). */
const POINT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bar: S.num('Bars from the clip start: 0 is its start, fractions allowed.'),
    value: S.VALUE(S.IN_UNIT),
    shape: {
      type: 'string',
      enum: ['curve', 'hold', 'stairs', 'smooth'],
      description:
        'How it moves on to the next point: curve (a line, bent by tension), hold, stairs, smooth (S-shape).',
    },
    tension: S.num('−1…1: bends the move to the next point (negative starts slowly, positive starts fast).'),
  },
  required: ['bar', 'value'],
};

/** A value in the control's own unit (as S.IN_UNIT says) → the 0–1 an automation point stores. Null when unreadable. */
export function normalizedOf(res: ResolvedTarget, target: ParamTarget, raw: unknown): number | null {
  switch (target.kind) {
    case 'channel':
    case 'insert':
    case 'route': {
      const v = num(raw);
      if (v === undefined) return null;
      const isLevel = target.kind === 'route' || target.param === 'volume';
      return res.toNormalized(isLevel ? (v <= -100 ? 0 : dbToGain(v)) : v);
    }
    case 'slot': {
      const v = num(raw);
      return v === undefined ? null : res.toNormalized(v > 1 && v <= 100 ? v / 100 : v);
    }
    case 'plugin': {
      const v = coerceParam(res.spec, raw);
      return v === null ? null : res.toNormalized(encode(res.spec, v));
    }
    case 'tempo': {
      const v = num(raw);
      return v === undefined ? null : res.toNormalized(v);
    }
  }
}

const dbOf = (gain: number) => (gain <= 0 ? -100 : r2(gainToDecibels(gain)));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A stored 0–1 point value in the control's own unit (dB, BPM, a plugin param's value…): what get_automation reports. */
export function ownUnitOf(res: ResolvedTarget, target: ParamTarget, n: number): number | string | boolean {
  const v = res.fromNormalized(n);
  if (target.kind === 'route' || ((target.kind === 'channel' || target.kind === 'insert') && target.param === 'volume'))
    return dbOf(v);
  if (target.kind === 'plugin') return decode(res.spec, v);
  return r3(v);
}

/** The name an automation channel's target has, as get_automation reports it ("drives"). */
export function automationDrives(s: Services, p: Project, ch: AutomationChannel): string {
  if (!ch.target) return 'nothing yet';
  return targetName(p, ch.target, pluginInfoOf(s)) ?? 'a control that no longer exists';
}

/** The control an automation target names (kind plus the ids it needs), as the model addresses it. */
export function paramTargetOf(c: OpContext, raw: unknown): ParamTarget {
  const { d, s } = c;
  const t = isObj(raw) ? raw : fail('what should the automation move?');
  const kind = str(t.kind);
  let target: ParamTarget;
  switch (kind) {
    case 'channel_volume':
    case 'channel_pan':
    case 'channel_pitch':
      target = {
        kind: 'channel',
        channelId: c.channel(t.channel),
        param: kind === 'channel_volume' ? 'volume' : kind === 'channel_pan' ? 'pan' : 'pitch',
      };
      break;
    case 'track_volume':
    case 'track_pan':
      target = { kind: 'insert', insertId: c.insert(t.insert), param: kind === 'track_volume' ? 'volume' : 'pan' };
      break;
    case 'send':
      target = { kind: 'route', insertId: c.insert(t.insert), to: c.insert(t.to) };
      break;
    case 'effect_mix': {
      const e = c.effect(t.effect);
      target = { kind: 'slot', insertId: e.insertId, slotId: e.slotId, param: 'mix' };
      break;
    }
    case 'plugin': {
      const name = str(t.param) ?? fail('which setting should it move?');
      let owner: PluginOwner;
      let pluginId: string;
      if (t.effect !== undefined) {
        const e = c.effect(t.effect);
        owner = { kind: 'fx', insertId: e.insertId, slotId: e.slotId };
        pluginId = d.mixer.inserts[e.insertId]!.fx.find((f) => f.id === e.slotId)!.plugin.pluginId;
      } else {
        const cid = c.channel(t.channel);
        const ch = d.channels[cid]!;
        if (ch.kind !== 'instrument') fail(`“${ch.name}” has no instrument settings`);
        owner = { kind: 'channel', channelId: cid };
        pluginId = (ch as { plugin: { pluginId: string } }).plugin.pluginId;
      }
      const def = s.plugins.get(pluginId) ?? fail(`the plugin ${pluginId} isn't installed`);
      const paramId = findParamId(def.params as ParamSpecs, name) ?? fail(`${def.name} has no setting "${name}"`);
      target = { kind: 'plugin', owner, paramId };
      break;
    }
    case 'tempo':
      target = { kind: 'tempo' };
      break;
    default:
      return fail(`can't automate "${String(t.kind)}"`);
  }
  return target;
}

const EDIT_MODES = ['set_points', 'move', 'scale', 'remove', 'tension'] as const;

const pluginInfoOf = (s: Services) => (id: string) => {
  const def = s.plugins.get(id);
  return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
};

/** The automation channel an edit names: by id, exact name or @ref, or by what it drives (as get_automation reports it). */
function automationChannelOf(c: OpContext, a: AiAction): AutomationChannel {
  const { d, s, project } = c;
  if (a.channel !== undefined) {
    const id = c.channel(a.channel);
    const ch = d.channels[id];
    if (ch?.kind !== 'automation') fail(`“${ch?.name ?? id}” is not an automation channel`);
    return project.channels[id] as AutomationChannel;
  }
  const drives =
    str(a.drives) ?? fail('which automation? give its channel, or what it drives (as get_automation reports it)');
  const hits = project.channelOrder
    .map((id) => project.channels[id]!)
    .filter(
      (ch): ch is AutomationChannel =>
        ch.kind === 'automation' && lower(automationDrives(s, project, ch)) === lower(drives),
    );
  if (hits.length === 0) fail(`nothing drives “${drives}”`);
  if (hits.length > 1)
    fail(`${hits.length} automation channels drive “${drives}”; give the one to change by its channel`);
  return hits[0]!;
}

/** A point the AI wrote, at a tick, with the shape and tension it asked for (as automate reads them). */
function pointFrom(pt: Record<string, unknown>, tick: Tick, value: number): AutoPoint {
  const shape = (['curve', 'hold', 'stairs', 'smooth'] as const).find((x) => x === str(pt.shape));
  const tension = num(pt.tension);
  return {
    tick,
    value,
    ...(shape && shape !== 'curve' ? { shape: shape as AutoShape } : {}),
    ...(tension !== undefined && tension !== 0 ? { tension: Math.min(1, Math.max(-1, tension)) } : {}),
  };
}

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
function editAutomation(a: AiAction, c: OpContext): string {
  const { d, s, project } = c;
  const mode =
    EDIT_MODES.find((m) => m === str(a.mode)) ??
    fail(`unknown mode "${String(a.mode)}" (set_points, move, scale, remove or tension)`);
  const ch = automationChannelOf(c, a);
  const id = ch.id;
  const barT = c.bar();
  const from = Math.max(0, num(a.from) ?? 0);
  const to = num(a.to);
  if (to !== undefined && to <= from) fail(`the range ends at bar ${r2(to)}, before it starts (bar ${r2(from)})`);
  const lo = Math.round(from * barT);
  const hi = to === undefined ? Infinity : Math.round(to * barT);
  const inRange = (p: AutoPoint) => p.tick >= lo && p.tick < hi;
  const rangeText =
    to === undefined ? (from === 0 ? 'the whole curve' : `bar ${r2(from)} on`) : `bars ${r2(from)}–${r2(to)}`;
  const info = pluginInfoOf(s);
  const name = (ch.target && targetName(project, ch.target, info)) || ch.name;
  const count = (n: number) => `${n} point${n === 1 ? '' : 's'}`;

  // Values need the control; it must still exist.
  const ctl = ch.target
    ? resolveTarget(project, ch.target, (x) => s.plugins.get(x)?.params as ParamSpecs | undefined, ch.range)
    : null;
  const control = () =>
    ch.target && ctl
      ? { res: ctl, target: ch.target }
      : fail(`${name} can't be edited: ${ch.target ? 'the control it drives no longer exists' : 'it drives nothing'}`);

  const old: AutoPoint[] = ch.points.map((p) => ({ ...p }));
  const edited = old.filter(inRange);
  const untouched = old.filter((p) => !inRange(p));
  if (mode !== 'set_points' && edited.length === 0) fail(`no points in ${rangeText}`);

  // The points the edit writes (their new positions), the whole curve after it, and the line for the chat.
  let touchedNew: AutoPoint[];
  let next: AutoPoint[];
  let line: string;
  switch (mode) {
    case 'set_points': {
      const { res, target } = control();
      const raw = Array.isArray(a.points) ? a.points.filter(isObj) : [];
      if (raw.length === 0) fail('set_points needs points: a bar and a value (in the control’s unit) for each');
      const fresh: AutoPoint[] = [];
      for (const pt of raw) {
        const value = normalizedOf(res, target, pt.value);
        const at = num(pt.bar);
        if (value === null || at === undefined) {
          c.warn(`automation point ${JSON.stringify(pt)} skipped`);
          continue;
        }
        if (at < from || (to !== undefined && at >= to)) {
          c.warn(`automation point at bar ${r2(at)} is outside ${rangeText}, skipped`);
          continue;
        }
        if (value < 0 || value > 1)
          c.warn(`${JSON.stringify(pt.value)} is past the range of ${name}; kept at its edge`);
        fresh.push(pointFrom(pt, Math.max(0, Math.round(at * barT)), value));
      }
      if (fresh.length === 0) fail(`none of the points is in ${rangeText}`);
      touchedNew = fresh;
      next = [...untouched, ...fresh];
      line = `set ${count(fresh.length)} in ${rangeText}`;
      break;
    }
    case 'move': {
      const by = num(a.by) ?? fail('move needs by: how many bars to shift the points (negative = earlier)');
      const shift = Math.round(by * barT);
      let early = 0;
      touchedNew = edited.map((p) => {
        const tick = p.tick + shift;
        if (tick < 0) early++;
        return { ...p, tick: Math.max(0, tick) };
      });
      if (early) c.warn(`${count(early)} would move before the start of the curve; kept at bar 0`);
      next = [...untouched, ...touchedNew];
      line = `moved ${count(edited.length)} by ${by > 0 ? '+' : ''}${r2(by)} bar${Math.abs(by) === 1 ? '' : 's'}`;
      break;
    }
    case 'scale': {
      const { res, target } = control();
      const factor =
        num(a.factor) ??
        fail('scale needs factor: 0 or more (2 doubles how far the points sit from their middle, 0.5 halves it)');
      if (factor < 0)
        fail('scale needs factor: 0 or more (2 doubles how far the points sit from their middle, 0.5 halves it)');
      const own = edited.map((p) => ownUnitOf(res, target, p.value));
      if (!own.every((v): v is number => typeof v === 'number'))
        fail(`${name} holds choices, not numbers, so it can't be scaled`);
      const nums = own as number[];
      const middle = (Math.min(...nums) + Math.max(...nums)) / 2;
      let past = 0;
      touchedNew = edited.map((p, i) => {
        const value = normalizedOf(res, target, middle + (nums[i]! - middle) * factor) ?? p.value;
        if (value < 0 || value > 1) past++;
        return { ...p, value: Math.min(1, Math.max(0, value)) };
      });
      if (past) c.warn(`${count(past)} went past the range of ${name}; kept at its edge`);
      next = [...untouched, ...touchedNew];
      line = `scaled ${count(edited.length)} around their middle (×${r2(factor)})`;
      break;
    }
    case 'remove': {
      next = untouched;
      if (next.length === 0)
        fail(`removing ${count(edited.length)} would leave the curve with no points; a curve keeps at least one`);
      touchedNew = [];
      line = `removed ${count(edited.length)}`;
      break;
    }
    case 'tension': {
      const t =
        num(a.tension) ?? fail('tension needs tension: −1…1 (negative starts the move slowly, positive starts fast)');
      const bend = Math.min(1, Math.max(-1, t));
      touchedNew = edited.map((p) => ({ ...p, tension: bend }));
      next = [...untouched, ...touchedNew];
      line = `set the tension of ${count(edited.length)} to ${r2(bend)}`;
      break;
    }
  }

  // The curve as it will be stored, and the content stretch that can change: from the untouched point
  // before the range to the one after it (a curve's segments reach both ways), plus anything written.
  const after = sanitizePoints(next);
  const prevTick = old.filter((p) => p.tick < lo).at(-1)?.tick ?? 0;
  const nextTick = old.find((p) => p.tick >= hi)?.tick ?? Infinity;
  const written = [...edited, ...touchedNew].map((p) => p.tick);
  const lowT = Math.min(prevTick, ...written);
  const highT = Math.max(nextTick, ...written.map((t) => t + 1));
  const lastTick = after.at(-1)?.tick ?? 0;

  // Every clip of the channel plays this curve: check each song stretch first, then write.
  const clips = (Object.values(project.playlist.clips) as Clip[]).filter(
    (x): x is AutomationClip => x.kind === 'automation' && x.channelId === id,
  );
  const grow: { clip: AutomationClip; length: number }[] = [];
  const touchedSpans: { from: Tick; to: Tick; clip: AutomationClip }[] = [];
  for (const clip of clips) {
    const contentEnd = clip.offset + clip.length;
    const length = lastTick > contentEnd ? Math.ceil((lastTick - clip.offset) / barT) * barT : clip.length;
    const newEnd = clip.offset + length;
    const songOf = (t: number) => clip.start + t - clip.offset;
    if (length > clip.length) {
      const songEnd = clip.start + length;
      const clash = (Object.values(project.playlist.clips) as Clip[]).find(
        (x) =>
          x.id !== clip.id &&
          x.laneId === clip.laneId &&
          x.start < songEnd &&
          x.start + x.length > clip.start + clip.length,
      );
      if (clash)
        fail(
          `the curve runs on past the end of its clip (bar ${r2(songOf(contentEnd) / barT + 1)}), into another clip on track ${project.playlist.laneOrder.indexOf(clip.laneId) + 1}`,
        );
      grow.push({ clip, length });
    }
    const A = Math.max(lowT, clip.offset);
    const B = Math.min(highT, newEnd);
    if (A < B) {
      c.focus.span(songOf(A), songOf(B), 'edit_automation');
      touchedSpans.push({ from: songOf(A), to: songOf(B), clip });
    }
    if (length > clip.length && !(A <= contentEnd && B >= newEnd)) {
      c.focus.span(songOf(contentEnd), songOf(newEnd), 'edit_automation');
      touchedSpans.push({ from: songOf(contentEnd), to: songOf(newEnd), clip });
    }
    // The value the clip leaves behind holds on after it, until something else plays: a change there reaches the rest of the song.
    const heldBefore = curveAt(old, contentEnd);
    const heldAfter = curveAt(after, newEnd);
    if (heldBefore !== null && heldAfter !== null && Math.abs(heldBefore - heldAfter) > 1e-6)
      c.focus.span(songOf(newEnd), Infinity, 'edit_automation');
  }

  setAutomationPoints(d, id, next);
  for (const { clip, length } of grow) (d.playlist.clips[clip.id] as Draft<AutomationClip>).length = length;
  for (const t of touchedSpans) c.touch(t.from, t.to, [t.clip.id]);
  return `${name}: ${line}`;
}

export const automation: OpModule = {
  schemas: [
    S.op(
      'automate',
      'Draws an automation clip on the playlist that moves one control over time when the song plays: fades, filter sweeps, risers, send throws, tempo ramps, wobbles. Give points, or an lfo for a repeating wave.',
      {
        ref: S.REF,
        target: S.AUTOMATION_TARGET,
        from_bar: S.int('1-based bar where the clip starts (default 1).'),
        bars: S.num('Length in bars (default 4).'),
        points: { type: 'array', description: 'The curve, in order.', items: POINT },
        lfo: {
          type: 'object',
          description: 'Instead of points: a repeating wave over the whole clip.',
          additionalProperties: false,
          properties: {
            shape: { type: 'string', enum: [...LFO_SHAPES] },
            beats: S.num('Cycle length in beats (1 = a quarter note, 0.5 = an eighth, 4 = a bar of 4/4).'),
            depth: S.num('0..1: how much of the control’s range it sweeps, peak to peak.'),
            center: S.VALUE(`The middle of the wave. ${S.IN_UNIT} Default: the control’s current value.`),
          },
          required: ['shape', 'beats', 'depth'],
        },
      },
      ['target'],
    ),
    S.op(
      'edit_automation',
      'Edits the points of an automation clip that already exists, in place (no delete and recreate): sets the points in a bar range, moves them in time, scales their values around their middle, removes them, or bends the curve leaving them. Name the clip by its channel (id or name, as get_automation lists it) or by what it drives. Bars count from the start of the curve, as get_automation reports them; values are in the control’s own unit.',
      {
        mode: {
          type: 'string',
          enum: [...EDIT_MODES],
          description:
            'set_points: replace the points in the range with the points given. move: shift them by bars. scale: multiply how far they sit from their middle by factor. remove: delete them. tension: set the bend of the curve leaving them.',
        },
        channel: { ...S.CHANNEL, description: 'The automation channel: its id, its exact name, or @ref.' },
        drives: S.str('Instead of channel: what it drives, as get_automation reports it (e.g. "Volume · Lead").'),
        from: S.num('The range starts at this bar of the curve (0 = its first bar; default 0).'),
        to: S.num('The range ends before this bar (default: the end of the curve).'),
        points: {
          type: 'array',
          description: 'set_points: the new points, in order, bars from the curve start inside the range.',
          items: POINT,
        },
        by: S.num('move: bars to shift the points by (negative = earlier).'),
        factor: S.num('scale: 0 or more. 2 doubles how far the points sit from their middle, 0.5 halves it.'),
        tension: S.num(
          'tension: −1…1 for the curve leaving each point (negative starts slowly, positive starts fast).',
        ),
      },
      ['mode'],
    ),
  ],
  handlers: {
    edit_automation: (a, c) => editAutomation(a, c),
    automate: (a, c) => {
      const { d, s, project } = c;
      const target = paramTargetOf(c, a.target);
      const specsOf = (id: string) => s.plugins.get(id)?.params as ParamSpecs | undefined;
      const lfo = isObj(a.lfo) ? a.lfo : null;
      const rawPoints = Array.isArray(a.points) ? a.points.filter(isObj) : [];
      // Tempo clips span 60–180 BPM unless the ramp goes further.
      let range: { min: number; max: number } | undefined;
      if (target.kind === 'tempo') {
        const bpms = [d.transport.bpm, ...rawPoints.map((pt) => num(pt.value)).filter((v) => v !== undefined)];
        if (lfo && num(lfo.center) !== undefined) bpms.push(num(lfo.center)!);
        const lo = Math.min(...(bpms as number[]));
        const hi = Math.max(...(bpms as number[]));
        range =
          lo < TEMPO_RANGE.min || hi > TEMPO_RANGE.max
            ? { min: tempoRange(lo).min, max: tempoRange(hi).max }
            : { ...TEMPO_RANGE };
      }
      const res: ResolvedTarget = resolveTarget(project, target, specsOf, range) ?? fail('that control does not exist');
      if (!isAutomatable(res.spec)) fail(`${res.spec.label ?? 'that setting'} can't be automated`);
      // A value in the control's own unit → 0–1 on the clip.
      const norm = (raw: unknown): number | null => normalizedOf(res, target, raw);
      const barT = c.bar();
      // In a part of the song, the clip defaults to the part.
      const part = c.focus.range();
      const start = Math.max(
        0,
        Math.round(num(a.from_bar) !== undefined || !part ? ((num(a.from_bar) ?? 1) - 1) * barT : part.from),
      );
      const length = Math.max(
        1,
        Math.round(num(a.bars) !== undefined || !part ? (num(a.bars) ?? 4) * barT : Math.max(barT, part.to - start)),
      );
      c.focus.span(start, start + length, 'automate');
      let points: AutoPoint[];
      let shapeText: string;
      if (lfo) {
        const shape = LFO_SHAPES.find((x) => x === str(lfo.shape)) ?? fail(`unknown LFO shape "${String(lfo.shape)}"`);
        const beats = Math.max(1 / 16, num(lfo.beats) ?? 1);
        const center = lfo.center === undefined ? res.toNormalized(res.base) : norm(lfo.center);
        if (center === null) fail(`can't use ${JSON.stringify(lfo.center)} as the middle of the wave`);
        points = lfoPoints(0, length, {
          shape: shape as LfoShape,
          period: beats * PPQ,
          depth: Math.min(1, Math.max(0, num(lfo.depth) ?? 0.5)),
          center: center!,
          phase: 0,
        });
        shapeText = `${shape} wave every ${r2(beats)} beat${beats === 1 ? '' : 's'}`;
      } else {
        points = [];
        for (const pt of rawPoints) {
          const value = norm(pt.value);
          const at = num(pt.bar);
          if (value === null || at === undefined) {
            c.warn(`automation point ${JSON.stringify(pt)} skipped`);
            continue;
          }
          const shape = (['curve', 'hold', 'stairs', 'smooth'] as const).find((x) => x === str(pt.shape));
          const tension = num(pt.tension);
          points.push({
            tick: Math.min(length, Math.max(0, Math.round(at * barT))),
            value,
            ...(shape && shape !== 'curve' ? { shape: shape as AutoShape } : {}),
            ...(tension !== undefined && tension !== 0 ? { tension: Math.min(1, Math.max(-1, tension)) } : {}),
          });
        }
        if (points.length === 0) fail('the automation needs points or an lfo');
        points.sort((x, y) => x.tick - y.tick);
        // One point is a held value.
        if (points.length === 1) points.push({ tick: length, value: points[0]!.value });
        const fmt = (pt: AutoPoint) => formatAutomationValue(res, target, pt.value);
        shapeText = `${fmt(points[0]!)} → ${fmt(points[points.length - 1]!)}`;
      }
      const closed = c.focus.closeAutomation(target, res, start, length, points);
      if (closed) c.note(closed);
      const pluginInfo = (id: string) => {
        const def = s.plugins.get(id);
        return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
      };
      const name = targetName(project, target, pluginInfo) ?? 'Automation';
      const automationCount = Object.values(d.channels).filter((ch) => ch?.kind === 'automation').length;
      const made = createAutomationClip(d, {
        target,
        name,
        color: paletteColor(automationCount * 3 + 5),
        start,
        length,
        points,
        ...(range ? { range } : {}),
      });
      c.touch(start, start + length, [made.clipId]);
      c.remember(a.ref, { kind: 'channel', id: made.channelId });
      return `Automation “${name}”, bars ${r2(start / barT + 1)}–${r2((start + length) / barT + 1)}: ${shapeText}`;
    },
  },
};
