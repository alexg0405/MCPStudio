/** Repair of the channel rack: instruments, audio-clip channels and automation channels. */
import { DEFAULT_CHANNEL_VOLUME, DEFAULT_ROOT_KEY, paletteColor } from '../../model/defaults';
import { AUDIO_STRETCH, MASTER, type AudioStretch } from '../../model/types';
import { type RepairLog, CHANNEL, countOf, noun } from './log';
import { CHANNEL_VOLUME_MAX } from './limits';
import { repairAutomationChannel } from './automation';
import { FieldRepairs } from './fields';
import { repairMidiFx } from './midi-fx';
import { repairPlugin } from './plugin';
import { repairOrder, repairRecords } from './records';
import { isSoundFilter } from './sound-filter';
import { hasOwn, isBoolean, isSet, isString, type JsonObject } from '../json-values';

/** The widest pitch offset of a channel, in cents (two octaves each way). */
const CHANNEL_PITCH_CENTS_MAX = 2400;
/** The highest MIDI key number. */
const MIDI_KEY_MAX = 127;
/** The slowest and fastest source tempo an audio-clip channel may claim, in BPM. */
const SOURCE_BPM_MIN = 20;
const SOURCE_BPM_MAX = 999;
const DEFAULT_SOURCE_BPM = 120;
/** How many channel names a repair message lists before saying "and N more". */
const MAX_NAMES_SHOWN = 3;

/**
 * Removes channels that cannot work (unknown type, no instrument, no sample), fixes the settings of
 * the rest, routes channels to the Master when their mixer track is gone, and repairs the channel list
 * and the links between audio channels (frozen-from, sound filters).
 */
export function repairChannels(project: JsonObject, log: RepairLog): void {
  const channels = project.channels as JsonObject;
  const inserts = (project.mixer as JsonObject).inserts as JsonObject;
  const samples = project.samples as JsonObject;
  const knownIds = repairRecords(channels, CHANNEL, log);

  const reroutedChannelNames: string[] = [];
  for (const [id, entry] of Object.entries(channels)) {
    const channel = entry as JsonObject;
    if (!canKeepChannel(channel, samples, log)) {
      delete channels[id];
      continue;
    }
    repairChannelSettings(channel, inserts, reroutedChannelNames, log);
  }
  log.flush();
  if (reroutedChannelNames.length) {
    const why =
      reroutedChannelNames.length === 1 ? 'its mixer track no longer exists' : 'their mixer tracks no longer exist';
    log.add(`Routed ${describeChannels(reroutedChannelNames)} to the Master track because ${why}.`);
  }
  project.channelOrder = repairOrder(
    project.channelOrder as unknown[],
    channels,
    knownIds,
    'channel list',
    CHANNEL,
    log,
  );
  unlinkMissingFrozenSources(channels, log);
  forgetDamagedSoundFilters(channels, log);
  log.flush();
}

/** True when the channel can stay; when not, counts why it is going (the caller deletes it). */
function canKeepChannel(channel: JsonObject, samples: JsonObject, log: RepairLog): boolean {
  const kind = channel.kind;
  if (kind !== 'instrument' && kind !== 'audioClip' && kind !== 'automation') {
    log.count('ch-kind', (n) => `Removed ${countOf(n, CHANNEL)} of an unknown type.`);
    return false;
  }
  if (kind === 'instrument' && !repairPlugin(channel.plugin, samples, log)) {
    log.count('ch-plugin', (n) => `Removed ${countOf(n, CHANNEL)} whose instrument data was missing.`);
    return false;
  }
  if (kind === 'audioClip' && !(isString(channel.sampleId) && hasOwn(samples, channel.sampleId))) {
    // Nothing can play without the sample entry; its clips go too (as orphans, in repairPlaylist).
    log.count('ch-sample', (n) => `Removed ${countOf(n, noun('audio clip channel'))} whose sample entry is missing.`);
    return false;
  }
  return true;
}

/** Fixes the settings every channel has plus those of its kind, then its volume, pan and mixer output. */
function repairChannelSettings(
  channel: JsonObject,
  inserts: JsonObject,
  reroutedChannelNames: string[],
  log: RepairLog,
): void {
  const fixes = new FieldRepairs(channel);
  fixes.require('name', isString, 'Channel');
  fixes.require('color', isString, paletteColor(0));
  fixes.require('muted', isBoolean, false);
  fixes.require('solo', isBoolean, false);
  if (channel.kind === 'instrument') repairInstrumentSettings(fixes);
  if (channel.kind === 'audioClip') repairAudioClipSettings(fixes);
  if (channel.kind === 'automation') {
    fixes.noteChange(repairAutomationChannel(channel));
  } else {
    repairLevelsAndOutput(channel, inserts, reroutedChannelNames, log);
  }
  repairMidiFx(channel, log);
  if (fixes.changed) log.count('ch-fields', (n) => `Fixed ${countOf(n, CHANNEL)} with invalid settings.`);
}

function repairInstrumentSettings(fixes: FieldRepairs): void {
  fixes.clampInteger('rootKey', 0, MIDI_KEY_MAX, DEFAULT_ROOT_KEY);
  fixes.clampIfSet('pitch', -CHANNEL_PITCH_CENTS_MAX, CHANNEL_PITCH_CENTS_MAX, 0);
}

function repairAudioClipSettings(fixes: FieldRepairs): void {
  fixes.clampIfSet('pitch', -CHANNEL_PITCH_CENTS_MAX, CHANNEL_PITCH_CENTS_MAX, 0);
  fixes.dropIfInvalid('reverse', isBoolean);
  fixes.dropIfInvalid('stretch', (v) => AUDIO_STRETCH.includes(v as AudioStretch));
  fixes.clampIfSet('sourceBpm', SOURCE_BPM_MIN, SOURCE_BPM_MAX, DEFAULT_SOURCE_BPM);
}

/** Volume and pan into range; an output that is not a mixer track goes to the Master. */
function repairLevelsAndOutput(
  channel: JsonObject,
  inserts: JsonObject,
  reroutedChannelNames: string[],
  log: RepairLog,
): void {
  const levels = new FieldRepairs(channel);
  levels.clamp('volume', 0, CHANNEL_VOLUME_MAX, DEFAULT_CHANNEL_VOLUME);
  levels.clamp('pan', -1, 1, 0);
  if (levels.changed) log.count('level', (n) => `Clamped ${countOf(n, noun('volume or pan setting'))} into range.`);
  if (!isString(channel.output) || !hasOwn(inserts, channel.output)) {
    channel.output = MASTER;
    reroutedChannelNames.push(channel.name as string);
  }
}

/** "channel "Kick"" for one name, "3 channels ("Kick", "Snare", "Hat" and 1 more)" for several. */
function describeChannels(names: readonly string[]): string {
  const quoted = names.slice(0, MAX_NAMES_SHOWN).map((name) => `"${name}"`);
  const more = names.length > MAX_NAMES_SHOWN ? ` and ${names.length - MAX_NAMES_SHOWN} more` : '';
  return names.length === 1 ? `channel ${quoted[0]}` : `${names.length} channels (${quoted.join(', ')}${more})`;
}

/** Frozen audio points at the channel it was rendered from: unlink it when that one is gone. */
function unlinkMissingFrozenSources(channels: JsonObject, log: RepairLog): void {
  for (const entry of Object.values(channels)) {
    const channel = entry as JsonObject;
    if (channel.kind !== 'audioClip' || !isSet(channel, 'frozenFrom')) continue;
    const source = isString(channel.frozenFrom) ? (channels[channel.frozenFrom] as JsonObject | undefined) : undefined;
    const isPlayable = source?.kind === 'instrument' || source?.kind === 'audioClip';
    if (source && source !== channel && isPlayable) continue;
    delete channel.frozenFrom;
    log.count('frozen', (n) => `Unlinked ${countOf(n, noun('frozen channel'))} from a channel that no longer exists.`);
  }
}

/** Sound filters keep what they replaced: a damaged record is forgotten (the filtered audio stays). */
function forgetDamagedSoundFilters(channels: JsonObject, log: RepairLog): void {
  for (const entry of Object.values(channels)) {
    const channel = entry as JsonObject;
    if (channel.kind !== 'audioClip' || !isSet(channel, 'filter')) continue;
    if (isSoundFilter(channel.filter)) continue;
    delete channel.filter;
    log.count('filter', (n) => `Forgot what ${countOf(n, noun('sound filter'))} replaced (the filtered audio stays).`);
  }
}
