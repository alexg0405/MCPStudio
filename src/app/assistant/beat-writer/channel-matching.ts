/** Finding the channels of a project a beat's tracks can reuse (same name, same drum, the project's 808). */
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import type { Style } from '@core/beat/style';
import { kitPiece, kitPieceFor, type KitSound } from '@core/model/kit';
import type { ChannelId, InstrumentChannel, PatternId, Project, SampleId } from '@core/model/types';
import { SAMPLER_ID } from '../../default-project';
import { BASS808_ID, KIT_FOR } from '../palette';

/** A name as compared between tracks and channels: trimmed and lowercase. */
export const lower = (name: string) => name.trim().toLowerCase();

/** The kit piece a sampler channel plays (stock or genre kit), if any. */
export function kitOf(project: Project, channel: InstrumentChannel) {
  if (channel.plugin.pluginId !== SAMPLER_ID) return undefined;
  const sample = project.samples[channel.plugin.samples?.main as SampleId];
  return sample?.source.kind === 'builtin' ? kitPiece(sample.source.generator) : undefined;
}

/** Whether a channel can play a track of `sound`: drums need a Sampler, pitched parts any other instrument. */
export function fits(project: Project, channel: InstrumentChannel, sound: BeatSound): boolean {
  if (DRUM_SOUNDS.has(sound)) return channel.plugin.pluginId === SAMPLER_ID;
  return !kitOf(project, channel) && channel.plugin.pluginId !== SAMPLER_ID;
}

/** Sampler params the writer manages on drum channels (velocity tone, the open hat's envelope). */
const WRITER_PARAMS = new Set(['velTone', 'envelope', 'attack', 'decay', 'sustain', 'release']);

/** A channel nobody has tuned: every param at its default (but the ones the writer sets itself). */
export function atDefaults(channel: InstrumentChannel, definition: PluginDef | undefined): boolean {
  if (!definition) return false;
  const defaults = defaultValues(definition.params);
  return Object.entries(defaults).every(
    ([paramId, value]) => WRITER_PARAMS.has(paramId) || (channel.plugin.params[paramId] ?? value) === value,
  );
}

/** Whether the channel plays in a pattern other than `patternId`. */
export function playsElsewhere(project: Project, channelId: ChannelId, patternId: PatternId): boolean {
  for (const otherPatternId of project.patternOrder) {
    if (otherPatternId === patternId) continue;
    const notes = project.patterns[otherPatternId]?.notes[channelId];
    if (notes && Object.keys(notes).length) return true;
  }
  return false;
}

/** An existing channel playing the same drum (the style's kit sample first) or the project's 808. */
export function existingChannel(
  project: Project,
  sound: BeatSound,
  taken: ReadonlySet<ChannelId>,
  style: Style,
): ChannelId | undefined {
  const preferredKit = DRUM_SOUNDS.has(sound) ? kitPieceFor(sound as KitSound, KIT_FOR[style])?.generator : undefined;
  let fallback: ChannelId | undefined;
  for (const id of project.channelOrder) {
    const channel = project.channels[id];
    if (!channel || channel.kind !== 'instrument' || taken.has(id)) continue;
    if (sound === '808' && channel.plugin.pluginId === BASS808_ID) return id;
    const piece = kitOf(project, channel);
    if (!piece || piece.sound !== sound) continue;
    if (piece.generator === preferredKit) return id;
    fallback ??= id;
  }
  return fallback;
}

/** The channel of the same name that can play the track. */
export function namedChannel(
  project: Project,
  name: string,
  sound: BeatSound,
  taken: ReadonlySet<ChannelId>,
): ChannelId | undefined {
  const key = lower(name);
  return project.channelOrder.find((id) => {
    const channel = project.channels[id];
    return (
      channel?.kind === 'instrument' && !taken.has(id) && lower(channel.name) === key && fits(project, channel, sound)
    );
  });
}

/** The pattern's channels by (lowercase) name, for rewriting a pattern a beat names. */
export function patternChannels(project: Project, patternId: PatternId): Record<string, ChannelId> {
  const byName: Record<string, ChannelId> = {};
  const notes = project.patterns[patternId]?.notes ?? {};
  for (const id of project.channelOrder) {
    const channel = project.channels[id];
    if (channel && Object.keys(notes[id] ?? {}).length) byName[lower(channel.name)] ??= id;
  }
  return byName;
}
