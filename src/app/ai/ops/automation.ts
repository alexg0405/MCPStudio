/** Automation clips: a control moving over time (points or an LFO). */
import { LFO_SHAPES, lfoPoints, type LfoShape } from '@core/automation/generate';
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget, TEMPO_RANGE, type ResolvedTarget } from '@core/automation/targets';
import { paletteColor } from '@core/model/defaults';
import type { AutoPoint, AutoShape, ParamTarget, PluginOwner } from '@core/model/types';
import { createAutomationClip } from '@core/ops/automation';
import { PPQ } from '@core/time/ppq';
import { dbToGain, encode, isAutomatable, type ParamSpecs } from '@agstudio/sdk';
import { tempoRange } from '../../automation';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { coerceParam, findParamId, isObj, num, r2, str } from './values';

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
        points: {
          type: 'array',
          description: 'The curve, in order.',
          items: {
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
          },
        },
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
  ],
  handlers: {
    automate: (a, c) => {
      const { d, s, project } = c;
      const t = isObj(a.target) ? a.target : fail('what should the automation move?');
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
      const norm = (raw: unknown): number | null => {
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
      };
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
