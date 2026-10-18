/** Planning a beat against a project: which pattern it writes, which channels its tracks reuse and which it creates. */
import type { PluginDef } from '@agstudio/sdk';
import { styleOfBeat } from '@core/beat/groove';
import { DRUM_SOUNDS, type BeatSpec, type BeatTrack } from '@core/beat/spec';
import type { Style } from '@core/beat/style';
import { newId } from '@core/model/ids';
import { kitPieceFor, type KitSound } from '@core/model/kit';
import type { ChannelId, InstrumentChannel, PatternId, Project, SampleRef } from '@core/model/types';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../../default-project';
import type { Services } from '../../services';
import { drumVolume, KIT_FOR } from '../palette';
import {
  atDefaults,
  existingChannel,
  fits,
  kitOf,
  lower,
  namedChannel,
  patternChannels,
  playsElsewhere,
} from './channel-matching';
import { pickSound } from './sounds';
import type { AppliedBeat, ApplyOptions, BeatPlan, PlannedTrack } from './types';

/** What planning every track of a beat shares and builds up. */
interface PlanState {
  services: Services;
  project: Project;
  style: Style;
  patternId: PatternId;
  /** The beat being rewritten, whose channels its tracks come back to. */
  reuse: AppliedBeat | null;
  options: ApplyOptions;
  /** The Sampler (drum channels are Sampler channels), when it is installed. */
  sampler: PluginDef | undefined;
  channels: Record<string, ChannelId>;
  created: Set<ChannelId>;
  /** Channels already given to a track of this beat. */
  taken: Set<ChannelId>;
  planned: PlannedTrack[];
  warnings: string[];
  /** The rack position the next new channel gets (it names default colors). */
  nextChannelIndex: number;
}

/** The beat to rewrite: the pattern a beat names (with the previous beat's channels if it is that beat), else the previous beat. */
function beatToRewrite(
  project: Project,
  previous: AppliedBeat | null | undefined,
  options: ApplyOptions,
): AppliedBeat | null {
  const named = options.patternId && project.patterns[options.patternId] ? options.patternId : undefined;
  const fromPrevious = previous && project.patterns[previous.patternId] ? previous : null;
  if (!named) return fromPrevious;
  if (fromPrevious?.patternId === named) return fromPrevious;
  return { patternId: named, channels: patternChannels(project, named), created: [] };
}

/** Records a track on a channel it now owns (new, or taken over). */
function claim(state: PlanState, key: string, channelId: ChannelId): void {
  state.taken.add(channelId);
  state.channels[key] = channelId;
}

/** A track that plays the musician's own sample ("use my sounds"): its previous Sampler channel switches to it, else a new one. */
function planOwnSampleTrack(
  state: PlanState,
  track: BeatTrack,
  key: string,
  sample: SampleRef,
  sampler: PluginDef,
): void {
  const { project, reuse, created, taken } = state;
  const prior = reuse?.channels[key];
  const mine = prior && created.has(prior) && !taken.has(prior) ? project.channels[prior] : undefined;
  if (prior && mine?.kind === 'instrument' && mine.plugin.pluginId === SAMPLER_ID) {
    claim(state, key, prior);
    state.planned.push({ track, channelId: prior, swap: sample, own: true });
    return;
  }
  const channel = instrumentChannelFor(sampler, sample.name, state.nextChannelIndex++, { main: sample.id });
  created.add(channel.id);
  claim(state, key, channel.id);
  state.planned.push({ track, channelId: channel.id, make: channel, sample, own: true });
}

/** The channel a track goes back to or finds: the one it had, one of the same name, or the project's kit channel or 808. */
function reusableChannel(state: PlanState, track: BeatTrack, key: string): ChannelId | undefined {
  const { project, reuse, taken, style } = state;
  const prior = reuse?.channels[key];
  const priorChannel = prior ? project.channels[prior] : undefined;
  const isPriorUsable =
    prior && priorChannel?.kind === 'instrument' && !taken.has(prior) && fits(project, priorChannel, track.sound);
  let channelId = isPriorUsable ? prior : undefined;
  channelId ??= namedChannel(project, track.name, track.sound, taken);
  const isDrumOr808 = DRUM_SOUNDS.has(track.sound) || track.sound === '808';
  channelId ??= isDrumOr808 ? existingChannel(project, track.sound, taken, style) : undefined;
  return channelId;
}

/** A track on a channel the project already has: what the writer may change about that channel. */
function planExistingChannelTrack(state: PlanState, track: BeatTrack, key: string, channelId: ChannelId): void {
  const { services, project, style, patternId, created, sampler } = state;
  claim(state, key, channelId);
  const channel = project.channels[channelId] as InstrumentChannel;
  const isDrum = DRUM_SOUNDS.has(track.sound);
  const planned: PlannedTrack = { track, channelId, own: created.has(channelId) };
  // A kit channel nobody has tuned or used elsewhere plays the style's kit and takes the writer's setup.
  const piece = isDrum ? kitOf(project, channel) : undefined;
  if (piece && atDefaults(channel, sampler) && !playsElsewhere(project, channelId, patternId)) {
    planned.own = true;
    const wanted = kitPieceFor(track.sound as KitSound, KIT_FOR[style]);
    if (wanted && wanted.generator !== piece.generator) planned.kit = kitSampleRef(wanted.generator);
  }
  if (planned.own && !isDrum && track.preset) {
    const sound = pickSound(services, style, track, state.warnings);
    if (sound && (sound.def.id !== channel.plugin.pluginId || track.preset)) {
      planned.sound = { def: sound.def, params: sound.params, state: sound.state };
    }
  }
  state.planned.push(planned);
}

/** A drum track with no channel to reuse: a new Sampler channel on the style's kit sample. */
function planNewDrumTrack(state: PlanState, track: BeatTrack, key: string): void {
  const { sampler, style, created } = state;
  if (!sampler) return;
  const piece = kitPieceFor(track.sound as KitSound, KIT_FOR[style]);
  if (!piece) return;
  const sample = kitSampleRef(piece.generator);
  const channel = instrumentChannelFor(sampler, track.name, state.nextChannelIndex++, { main: sample.id });
  channel.volume = drumVolume(track.sound as KitSound, piece.kit);
  created.add(channel.id);
  claim(state, key, channel.id);
  state.planned.push({ track, channelId: channel.id, make: channel, sample, own: true });
}

/** A pitched track with no channel to reuse: a new channel with the palette's (or the named preset's) instrument. */
function planNewPitchedTrack(state: PlanState, track: BeatTrack, key: string): void {
  const { services, style, created } = state;
  const sound = pickSound(services, style, track, state.warnings);
  if (!sound) return;
  const channel = instrumentChannelFor(sound.def, track.name, state.nextChannelIndex++);
  channel.plugin.params = sound.params;
  if (sound.state !== undefined) channel.plugin.state = sound.state as never;
  channel.volume = sound.volume;
  if (sound.rootKey !== undefined) channel.rootKey = sound.rootKey;
  created.add(channel.id);
  claim(state, key, channel.id);
  state.planned.push({ track, channelId: channel.id, make: channel, own: true });
}

/** Plans one track of the beat. */
function planTrack(state: PlanState, track: BeatTrack): void {
  const key = lower(track.name);
  const ownSample = state.options.samples?.[track.sound];
  if (ownSample && state.sampler) {
    planOwnSampleTrack(state, track, key, ownSample, state.sampler);
    return;
  }
  const channelId = reusableChannel(state, track, key);
  if (channelId) {
    planExistingChannelTrack(state, track, key, channelId);
    return;
  }
  if (DRUM_SOUNDS.has(track.sound)) planNewDrumTrack(state, track, key);
  else planNewPitchedTrack(state, track, key);
}

/**
 * Plans a beat against a project (or a draft of one, inside a larger edit): which pattern it
 * writes, which channels its tracks reuse and which it creates.
 */
export function planBeat(
  services: Services,
  project: Project,
  spec: BeatSpec,
  previous?: AppliedBeat | null,
  options: ApplyOptions = {},
): BeatPlan {
  const style =
    spec.style ??
    styleOfBeat(spec.tracks, spec.bars, spec.bpm ?? project.transport.bpm, spec.swing ?? project.transport.swing);
  const reuse = beatToRewrite(project, previous, options);
  const state: PlanState = {
    services,
    project,
    style,
    patternId: reuse?.patternId ?? newId.pattern(),
    reuse,
    options,
    sampler: services.plugins.get(SAMPLER_ID),
    channels: {},
    created: new Set<ChannelId>([...(reuse?.created ?? []), ...(options.own ?? [])]),
    taken: new Set<ChannelId>(),
    planned: [],
    warnings: [],
    nextChannelIndex: project.channelOrder.length,
  };
  for (const track of spec.tracks) planTrack(state, track);
  const levels = new Set<ChannelId>();
  for (const planned of state.planned) {
    if (planned.track.volume !== undefined || planned.track.pan !== undefined) levels.add(planned.channelId);
  }
  return {
    patternId: state.patternId,
    reuse,
    channels: state.channels,
    created: state.created,
    style,
    levels,
    warnings: state.warnings,
    tracks: state.planned,
  };
}
