/** Descriptions several read tools share: a plugin's settings, the preset an instance is at, a channel in brief. */
import { formatValue, type ParamSpec, type ParamSpecs, type ParamValue, type PluginDef } from '@agstudio/sdk';
import type { Channel, PluginInstance, PluginOwner, Project } from '@core/model/types';
import { isAtPreset, presetChoices } from '../../presets';
import type { Services } from '../../services';
import { lower } from '../ops/values';
import { mixerNumber } from './tool';

/** One param as the AI sets it: id, the value in its unit, the text shown, and its range or options. */
export function describeParam(id: string, spec: ParamSpec, value: ParamValue | undefined): Record<string, unknown> {
  const shownValue = value ?? spec.default;
  const label = spec.label && lower(spec.label) !== lower(id) ? { label: spec.label } : {};
  const base = { id, ...label, type: spec.type, value: shownValue, text: formatValue(spec, shownValue) };
  switch (spec.type) {
    case 'float':
    case 'int':
      return {
        ...base,
        ...(spec.unit ? { unit: spec.unit === '%' ? '0–1 (shown as %)' : spec.unit } : {}),
        min: spec.min,
        max: spec.max,
        default: spec.default,
      };
    case 'enum':
      return { ...base, options: [...spec.options], default: spec.default };
    case 'bool':
      return { ...base, default: spec.default };
  }
}

/** A plugin instance's settings: all of them, or only those that differ from the defaults. */
export function describeParams(
  definition: PluginDef | undefined,
  instance: PluginInstance,
  includeDefaults: boolean,
): Record<string, unknown>[] {
  if (!definition) return [];
  const described: Record<string, unknown>[] = [];
  for (const [id, spec] of Object.entries(definition.params as ParamSpecs) as [string, ParamSpec][]) {
    const value = instance.params[id];
    const isDefault = value === undefined || value === spec.default;
    if (!includeDefaults && isDefault) continue;
    described.push(describeParam(id, spec, value));
  }
  return described;
}

/** The preset an instance is at: the first whose settings match, else the last one loaded (marked edited). */
export function presetOf(
  services: Services,
  definition: PluginDef | undefined,
  instance: PluginInstance,
  owner: PluginOwner,
) {
  if (!definition) return null;
  const match = presetChoices(definition, services.presets).find((preset) => isAtPreset(definition, instance, preset));
  if (match) return { name: match.name, edited: false };
  const lastLoaded = services.presets.loadedInto(owner);
  return lastLoaded ? { name: lastLoaded, edited: true } : null;
}

/** A plugin's name, or its id marked missing when it isn't installed. */
export const pluginName = (services: Services, pluginId: string) =>
  services.plugins.get(pluginId)?.name ?? `${pluginId} (missing)`;

/** Channels that make sound (the automation ones are listed by get_automation). */
export const soundChannels = (project: Project): Channel[] =>
  project.channelOrder.map((id) => project.channels[id]!).filter((channel) => channel.kind !== 'automation');

/** A channel's id, name, kind, plugin, mixer track and mute state: what lists of channels show. */
export function channelBrief(project: Project, services: Services, channel: Channel) {
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    ...(channel.kind === 'instrument'
      ? { plugin: channel.plugin.pluginId, plugin_name: pluginName(services, channel.plugin.pluginId) }
      : {}),
    ...(channel.kind !== 'automation' ? { insert: mixerNumber(project, channel.output) } : {}),
    ...(channel.muted ? { muted: true } : {}),
  };
}
