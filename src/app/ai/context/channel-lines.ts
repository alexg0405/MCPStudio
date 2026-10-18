/** The channel rack as text: one block per channel with its plugin settings, level and mixer track. */
import type { ParamSpec, ParamSpecs } from '@agstudio/sdk';
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { kitPiece } from '@core/model/kit';
import {
  MASTER,
  type Channel,
  type ChannelId,
  type PatternId,
  type PluginInstance,
  type Project,
} from '@core/model/types';
import { patternSpans } from '@core/query/arrangement';
import { insertLabel } from '@core/query/mixer';
import type { Services } from '../../services';
import { SHORT_VALUES, FULL_CHANNELS, type ContextRender, type Section } from './budget';
import { formatDb, round2 } from './units';

/** A plugin's name, or its id marked missing when it isn't installed. */
export function pluginName(services: Services, pluginId: string): string {
  return services.plugins.get(pluginId)?.name ?? `${pluginId} (missing)`;
}

/** Settings that differ from the plugin's defaults, as `name value` (formatted in the param's unit). */
export function paramSummary(
  services: Services,
  instance: PluginInstance,
  render: ContextRender,
  section: Section,
): string {
  const definition = services.plugins.get(instance.pluginId);
  if (!definition) return 'plugin not installed';
  const changed: { id: string; text: string }[] = [];
  for (const [id, spec] of Object.entries(definition.params as ParamSpecs) as [string, ParamSpec][]) {
    const value = instance.params[id];
    if (value === undefined || value === spec.default) continue;
    const number = spec.type === 'float' || spec.type === 'int' ? round2(Number(value)) : String(value);
    const unit = spec.type === 'float' && spec.unit && spec.unit !== '%' ? ` ${spec.unit}` : '';
    changed.push({ id, text: `${id} ${number}${unit}` });
  }
  if (changed.length === 0) return 'defaults';
  if (!render.shorten.settings || changed.length <= SHORT_VALUES)
    return changed.map((setting) => setting.text).join(', ');
  render.cut.add(section);
  return changed.map((setting, index) => (index < SHORT_VALUES ? setting.text : setting.id)).join(', ');
}

/** Channels with notes in a pattern the song plays, or with a clip on the playlist. */
export function channelsThatPlay(project: Project): Set<string> {
  const playing = new Set<string>();
  for (const patternId of patternSpans(project).keys()) {
    const pattern = project.patterns[patternId];
    if (!pattern) continue;
    for (const [channelId, notes] of Object.entries(pattern.notes)) {
      if (Object.keys(notes ?? {}).length) playing.add(channelId);
    }
  }
  for (const clip of Object.values(project.playlist.clips)) if (clip.kind !== 'pattern') playing.add(clip.channelId);
  return playing;
}

/** What a channel is, in one word for a compact line. */
export function channelKind(services: Services, channel: Channel): string {
  if (channel.kind === 'instrument') return pluginName(services, channel.plugin.pluginId);
  return channel.kind === 'audioClip' ? 'audio clip' : 'automation';
}

/**
 * The channels kept in full when shortened: the selected one, then the channels with notes in the full
 * patterns (in rack order), up to `FULL_CHANNELS`.
 */
export function fullChannels(
  project: Project,
  patterns: ReadonlySet<PatternId>,
  selected: ChannelId | null,
): Set<string> {
  const used = new Set<string>();
  for (const patternId of patterns) {
    const pattern = project.patterns[patternId];
    if (!pattern) continue;
    for (const [channelId, notes] of Object.entries(pattern.notes)) {
      if (Object.keys(notes ?? {}).length) used.add(channelId);
    }
  }
  const kept = new Set<string>();
  if (selected && project.channels[selected]) kept.add(selected);
  for (const id of project.channelOrder) {
    if (kept.size >= FULL_CHANNELS) break;
    if (used.has(id)) kept.add(id);
  }
  return kept;
}

/** "automation of “Cutoff · 3xOsc”: 3 points, 400 Hz → 8.0 kHz" (values as the control shows them). */
function automationSummary(
  services: Services,
  project: Project,
  channel: Extract<Channel, { kind: 'automation' }>,
): string {
  const pluginInfo = (pluginId: string) => {
    const definition = services.plugins.get(pluginId);
    return definition ? { name: definition.name, params: definition.params as ParamSpecs } : undefined;
  };
  const { target, points } = channel;
  if (!target) return `automation that drives nothing yet: ${points.length} points`;
  const what = targetName(project, target, pluginInfo) ?? 'a control that no longer exists';
  const resolved = resolveTarget(
    project,
    target,
    (pluginId) => services.plugins.get(pluginId)?.params as ParamSpecs | undefined,
    channel.range,
  );
  const span =
    resolved && points.length > 0
      ? `, ${formatAutomationValue(resolved, target, points[0]!.value)} → ${formatAutomationValue(resolved, target, points[points.length - 1]!.value)}`
      : '';
  return `automation of “${what}”: ${points.length} point${points.length === 1 ? '' : 's'}${span}`;
}

/** An audio-clip channel's edits in words ("pitch 100 ct, reversed"). */
function audioEdits(channel: Extract<Channel, { kind: 'audioClip' }>): string[] {
  return [
    channel.pitch ? `pitch ${channel.pitch} ct` : '',
    channel.reverse ? 'reversed' : '',
    channel.stretch && channel.stretch !== 'off' ? `follows the tempo (${channel.stretch})` : '',
    channel.sourceBpm ? `recorded at ${channel.sourceBpm} BPM` : '',
  ].filter(Boolean);
}

/** One channel: id, plugin (or sample), level, pan, mixer track and its changed settings. */
export function channelLine(
  services: Services,
  project: Project,
  channel: Channel,
  number: number,
  render: ContextRender,
): string {
  const head = `${number}. "${channel.name}" ${channel.id}`;
  const flags = [channel.muted ? 'muted' : '', channel.solo ? 'solo' : ''].filter(Boolean).join(', ');
  if (channel.kind === 'automation') {
    return `${head} — ${automationSummary(services, project, channel)}${flags ? ` (${flags})` : ''}`;
  }
  const outputName = channel.output === MASTER ? '' : ` "${project.mixer.inserts[channel.output]?.name ?? ''}"`;
  const output = `→ ${insertLabel(project, channel.output)}${outputName}`;
  const pitch = channel.kind === 'instrument' && channel.pitch ? `, pitch ${channel.pitch} ct` : '';
  const mix = `vol ${formatDb(channel.volume)}, pan ${round2(channel.pan)}${pitch}${flags ? `, ${flags}` : ''}`;
  if (channel.kind === 'audioClip') {
    const edits = audioEdits(channel);
    const sampleName = project.samples[channel.sampleId]?.name ?? '?';
    return `${head} — audio clip "${sampleName}"${edits.length ? ` (${edits.join(', ')})` : ''}; ${mix}; ${output}`;
  }
  const sample = channel.plugin.samples?.main ? project.samples[channel.plugin.samples.main] : undefined;
  const kit = sample?.source.kind === 'builtin' ? kitPiece(sample.source.generator)?.name : sample?.name;
  const plugin = `${pluginName(services, channel.plugin.pluginId)} (${channel.plugin.pluginId})`;
  return `${head} — ${plugin}${kit ? ` sample "${kit}"` : ''}; ${mix}; ${output}\n   settings: ${paramSummary(services, channel.plugin, render, 'channels')}`;
}
