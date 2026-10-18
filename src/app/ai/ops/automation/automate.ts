/** automate: draws a new automation clip on the playlist (the points given, or an LFO). */
import { LFO_SHAPES, lfoPoints, type LfoShape } from '@core/automation/generate';
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget, TEMPO_RANGE, type ResolvedTarget } from '@core/automation/targets';
import { paletteColor } from '@core/model/defaults';
import type { AutoPoint, ParamTarget, Tick } from '@core/model/types';
import { createAutomationClip } from '@core/ops/automation';
import { PPQ } from '@core/time/ppq';
import { isAutomatable, type ParamSpecs } from '@agstudio/sdk';
import { tempoRange } from '../../../automation';
import type { AiAction } from '../../schema';
import { fail, type OpContext } from '../context';
import { isObj, num, r2, str } from '../values';
import { pointFrom } from './edit';
import { normalizedOf, paramTargetOf, pluginInfoOf } from './targets';

/** How long an automation clip is when the answer doesn't say (bars). */
const DEFAULT_CLIP_BARS = 4;
/** The shortest LFO cycle (beats). */
const MIN_LFO_BEATS = 1 / 16;
/** How deep an LFO sweeps when it doesn't say (0–1 of the control's range). */
const DEFAULT_LFO_DEPTH = 0.5;

/** Tempo clips span 60–180 BPM unless the ramp goes further: the range this clip needs (undefined for other controls). */
function tempoClipRange(
  context: OpContext,
  target: ParamTarget,
  rawPoints: Record<string, unknown>[],
  lfo: Record<string, unknown> | null,
): { min: number; max: number } | undefined {
  if (target.kind !== 'tempo') return undefined;
  const bpms = [
    context.draft.transport.bpm,
    ...rawPoints.map((point) => num(point.value)).filter((value) => value !== undefined),
  ];
  if (lfo && num(lfo.center) !== undefined) bpms.push(num(lfo.center)!);
  const lowest = Math.min(...(bpms as number[]));
  const highest = Math.max(...(bpms as number[]));
  if (lowest < TEMPO_RANGE.min || highest > TEMPO_RANGE.max) {
    return { min: tempoRange(lowest).min, max: tempoRange(highest).max };
  }
  return { ...TEMPO_RANGE };
}

/** Where the clip starts and how long it is (ticks). In a part of the song, the clip defaults to the part. */
function clipSpan(action: AiAction, context: OpContext): { start: Tick; length: Tick } {
  const ticksPerBar = context.bar();
  const part = context.focus.range();
  const fromBar = num(action.from_bar);
  const bars = num(action.bars);
  const start = Math.max(
    0,
    Math.round(fromBar !== undefined || !part ? ((fromBar ?? 1) - 1) * ticksPerBar : part.from),
  );
  const length = Math.max(
    1,
    Math.round(
      bars !== undefined || !part ? (bars ?? DEFAULT_CLIP_BARS) * ticksPerBar : Math.max(ticksPerBar, part.to - start),
    ),
  );
  return { start, length };
}

/** The curve of an LFO clip and how to say it. */
function lfoCurve(
  lfo: Record<string, unknown>,
  resolved: ResolvedTarget,
  target: ParamTarget,
  length: Tick,
): { points: AutoPoint[]; text: string } {
  const shape =
    LFO_SHAPES.find((candidate) => candidate === str(lfo.shape)) ?? fail(`unknown LFO shape "${String(lfo.shape)}"`);
  const beats = Math.max(MIN_LFO_BEATS, num(lfo.beats) ?? 1);
  const center =
    lfo.center === undefined ? resolved.toNormalized(resolved.base) : normalizedOf(resolved, target, lfo.center);
  if (center === null) fail(`can't use ${JSON.stringify(lfo.center)} as the middle of the wave`);
  const points = lfoPoints(0, length, {
    shape: shape as LfoShape,
    period: beats * PPQ,
    depth: Math.min(1, Math.max(0, num(lfo.depth) ?? DEFAULT_LFO_DEPTH)),
    center: center!,
    phase: 0,
  });
  return { points, text: `${shape} wave every ${r2(beats)} beat${beats === 1 ? '' : 's'}` };
}

/** The curve of a clip drawn from points (a single point is a held value) and how to say it. */
function drawnCurve(
  context: OpContext,
  rawPoints: Record<string, unknown>[],
  resolved: ResolvedTarget,
  target: ParamTarget,
  length: Tick,
): { points: AutoPoint[]; text: string } {
  const ticksPerBar = context.bar();
  const points: AutoPoint[] = [];
  for (const raw of rawPoints) {
    const value = normalizedOf(resolved, target, raw.value);
    const bar = num(raw.bar);
    if (value === null || bar === undefined) {
      context.warn(`automation point ${JSON.stringify(raw)} skipped`);
      continue;
    }
    points.push(pointFrom(raw, Math.min(length, Math.max(0, Math.round(bar * ticksPerBar))), value));
  }
  if (points.length === 0) fail('the automation needs points or an lfo');
  points.sort((a, b) => a.tick - b.tick);
  // One point is a held value.
  if (points.length === 1) points.push({ tick: length, value: points[0]!.value });
  const valueText = (point: AutoPoint) => formatAutomationValue(resolved, target, point.value);
  return { points, text: `${valueText(points[0]!)} → ${valueText(points[points.length - 1]!)}` };
}

/** automate: see the file comment. Returns the chat line. */
export function automate(action: AiAction, context: OpContext): string {
  const { draft, services, project } = context;
  const target = paramTargetOf(context, action.target);
  const specsOf = (pluginId: string) => services.plugins.get(pluginId)?.params as ParamSpecs | undefined;
  const lfo = isObj(action.lfo) ? action.lfo : null;
  const rawPoints = Array.isArray(action.points) ? action.points.filter(isObj) : [];
  const range = tempoClipRange(context, target, rawPoints, lfo);
  const resolved: ResolvedTarget =
    resolveTarget(project, target, specsOf, range) ?? fail('that control does not exist');
  if (!isAutomatable(resolved.spec)) fail(`${resolved.spec.label ?? 'that setting'} can't be automated`);
  const ticksPerBar = context.bar();
  const { start, length } = clipSpan(action, context);
  context.focus.span(start, start + length, 'automate');
  const curve = lfo
    ? lfoCurve(lfo, resolved, target, length)
    : drawnCurve(context, rawPoints, resolved, target, length);
  const closed = context.focus.closeAutomation(target, resolved, start, length, curve.points);
  if (closed) context.note(closed);
  const name = targetName(project, target, pluginInfoOf(services)) ?? 'Automation';
  const automationCount = Object.values(draft.channels).filter((channel) => channel?.kind === 'automation').length;
  const made = createAutomationClip(draft, {
    target,
    name,
    color: paletteColor(automationCount * 3 + 5),
    start,
    length,
    points: curve.points,
    ...(range ? { range } : {}),
  });
  context.touch(start, start + length, [made.clipId]);
  context.remember(action.ref, { kind: 'channel', id: made.channelId });
  return `Automation “${name}”, bars ${r2(start / ticksPerBar + 1)}–${r2((start + length) / ticksPerBar + 1)}: ${curve.text}`;
}
