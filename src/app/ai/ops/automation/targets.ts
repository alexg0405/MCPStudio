/**
 * The controls automation can move, in the AI's terms: finding one from the way the model names it, turning a value in
 * the control's own unit into the 0–1 an automation point stores (and back), and naming what a channel drives.
 */
import { targetName } from '@core/automation/labels';
import type { ResolvedTarget } from '@core/automation/targets';
import { gainToDecibels } from '@core/model/fader';
import type { AutomationChannel, ParamTarget, PluginOwner, Project } from '@core/model/types';
import { dbToGain, decode, encode, type ParamSpecs } from '@agstudio/sdk';
import type { Services } from '../../../services';
import { fail, type OpContext } from '../context';
import { coerceParam, findParamId, isObj, num, r2, str } from '../values';

/** A level in dB for the model; silence is −100 (JSON has no −Infinity). */
const gainAsDb = (gain: number) => (gain <= 0 ? -100 : r2(gainToDecibels(gain)));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** A level at or below this many dB is silence (the model writes −100 for it). */
const SILENCE_DB = -100;

/** What a percentage-or-fraction value means for an effect's dry/wet: 1–100 is percent, 0–1 is the fraction itself. */
const asFraction = (value: number) => (value > 1 && value <= 100 ? value / 100 : value);

/** Plugin names and settings, for naming what a control is. */
export const pluginInfoOf = (services: Services) => (pluginId: string) => {
  const definition = services.plugins.get(pluginId);
  return definition ? { name: definition.name, params: definition.params as ParamSpecs } : undefined;
};

/** A value in the control's own unit (as S.IN_UNIT says) → the 0–1 an automation point stores. Null when unreadable. */
export function normalizedOf(resolved: ResolvedTarget, target: ParamTarget, raw: unknown): number | null {
  switch (target.kind) {
    case 'channel':
    case 'insert':
    case 'route': {
      const value = num(raw);
      if (value === undefined) return null;
      const isLevel = target.kind === 'route' || target.param === 'volume';
      const inOwnUnit = isLevel ? (value <= SILENCE_DB ? 0 : dbToGain(value)) : value;
      return resolved.toNormalized(inOwnUnit);
    }
    case 'slot': {
      const value = num(raw);
      return value === undefined ? null : resolved.toNormalized(asFraction(value));
    }
    case 'plugin': {
      const value = coerceParam(resolved.spec, raw);
      return value === null ? null : resolved.toNormalized(encode(resolved.spec, value));
    }
    case 'tempo': {
      const value = num(raw);
      return value === undefined ? null : resolved.toNormalized(value);
    }
  }
}

/** A stored 0–1 point value in the control's own unit (dB, BPM, a plugin param's value…): what get_automation reports. */
export function ownUnitOf(
  resolved: ResolvedTarget,
  target: ParamTarget,
  normalized: number,
): number | string | boolean {
  const value = resolved.fromNormalized(normalized);
  const isLevel =
    target.kind === 'route' || ((target.kind === 'channel' || target.kind === 'insert') && target.param === 'volume');
  if (isLevel) return gainAsDb(value);
  if (target.kind === 'plugin') return decode(resolved.spec, value);
  return round3(value);
}

/** The name an automation channel's target has, as get_automation reports it ("drives"). */
export function automationDrives(services: Services, project: Project, channel: AutomationChannel): string {
  if (!channel.target) return 'nothing yet';
  return targetName(project, channel.target, pluginInfoOf(services)) ?? 'a control that no longer exists';
}

const CHANNEL_PARAMS = { channel_volume: 'volume', channel_pan: 'pan', channel_pitch: 'pitch' } as const;
const TRACK_PARAMS = { track_volume: 'volume', track_pan: 'pan' } as const;

/** The plugin setting an automation target names: on an effect or on a channel's instrument. */
function pluginTarget(context: OpContext, raw: Record<string, unknown>): ParamTarget {
  const { draft, services } = context;
  const settingName = str(raw.param) ?? fail('which setting should it move?');
  let owner: PluginOwner;
  let pluginId: string;
  if (raw.effect !== undefined) {
    const effect = context.effect(raw.effect);
    owner = { kind: 'fx', insertId: effect.insertId, slotId: effect.slotId };
    pluginId = draft.mixer.inserts[effect.insertId]!.fx.find((slot) => slot.id === effect.slotId)!.plugin.pluginId;
  } else {
    const channelId = context.channel(raw.channel);
    const channel = draft.channels[channelId]!;
    if (channel.kind !== 'instrument') fail(`“${channel.name}” has no instrument settings`);
    owner = { kind: 'channel', channelId };
    pluginId = (channel as { plugin: { pluginId: string } }).plugin.pluginId;
  }
  const definition = services.plugins.get(pluginId) ?? fail(`the plugin ${pluginId} isn't installed`);
  const paramId =
    findParamId(definition.params as ParamSpecs, settingName) ??
    fail(`${definition.name} has no setting "${settingName}"`);
  return { kind: 'plugin', owner, paramId };
}

/** The control an automation target names (kind plus the ids it needs), as the model addresses it. */
export function paramTargetOf(context: OpContext, raw: unknown): ParamTarget {
  const named = isObj(raw) ? raw : fail('what should the automation move?');
  const kind = str(named.kind);
  switch (kind) {
    case 'channel_volume':
    case 'channel_pan':
    case 'channel_pitch':
      return { kind: 'channel', channelId: context.channel(named.channel), param: CHANNEL_PARAMS[kind] };
    case 'track_volume':
    case 'track_pan':
      return { kind: 'insert', insertId: context.insert(named.insert), param: TRACK_PARAMS[kind] };
    case 'send':
      return { kind: 'route', insertId: context.insert(named.insert), to: context.insert(named.to) };
    case 'effect_mix': {
      const effect = context.effect(named.effect);
      return { kind: 'slot', insertId: effect.insertId, slotId: effect.slotId, param: 'mix' };
    }
    case 'plugin':
      return pluginTarget(context, named);
    case 'tempo':
      return { kind: 'tempo' };
    default:
      return fail(`can't automate "${String(named.kind)}"`);
  }
}
