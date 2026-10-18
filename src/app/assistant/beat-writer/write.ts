/** Writing a planned beat into a draft: the pattern, its notes, new channels and the sound setup of channels it owns. */
import type { Draft } from 'immer';
import type { ParamSpec } from '@agstudio/sdk/params';
import { DRUM_SOUNDS, type BeatSpec, type BeatTrack } from '@core/beat/spec';
import { DEFAULT_CHANNEL_VOLUME, makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { kitPiece, type KitSound } from '@core/model/kit';
import type { InstrumentChannel, Note, PluginInstance, Project, SampleId } from '@core/model/types';
import { addChannel, addSample, setPluginSample } from '@core/ops/channels';
import { setBpm, setSwing } from '@core/ops/notes';
import { addPattern } from '@core/ops/playlist';
import { TICKS_PER_STEP } from '@core/time/ppq';
import { SAMPLER_ID } from '../../default-project';
import type { Services } from '../../services';
import { BASS808_ID, drumVolume } from '../palette';
import type { BeatPlan, PlannedTrack } from './types';

/** The slide floor: overlapping 808 notes glide audibly (at least 60 ms). */
const MIN_GLIDE_SEC = 0.06;
/** The shortest note the writer makes (ticks). */
const MIN_NOTE_TICKS = 10;
/** The velocity a note without one gets. */
const DEFAULT_VELOCITY = 0.8;
/** Steps per bar in a written pattern (the beat spec counts in 1/16 steps). */
const STEPS_PER_BAR = 16;
/** A note's overlap with the next must exceed this (steps) to count as a slide. */
const OVERLAP_EPSILON_STEPS = 1e-9;
/** The velocity tone a drum sampler is given, so soft notes in rolls sound softer (not just quieter). */
const DRUM_VELOCITY_TONE = 0.5;
/** An open hat's envelope when it stops at the next closed hat (see core/beat/groove.ts). */
const OPEN_HAT_ENVELOPE = { attack: 0.001, sustain: 1, release: 0.05 };

/** A number limited to a numeric param's range (and rounded for an integer param); null for any other param. */
function clampParam(spec: ParamSpec | undefined, value: number): number | null {
  if (!spec || (spec.type !== 'float' && spec.type !== 'int')) return null;
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  return spec.type === 'int' ? Math.round(clamped) : clamped;
}

/** The notes of a track as project notes: drums all play the channel's root key. */
function notesFor(track: BeatTrack, rootKey: number): Note[] {
  const isDrum = DRUM_SOUNDS.has(track.sound);
  return track.notes.map((note) => ({
    id: newId.note(),
    tick: Math.round(note.step * TICKS_PER_STEP),
    length: Math.max(MIN_NOTE_TICKS, Math.round((note.len ?? 1) * TICKS_PER_STEP)),
    key: isDrum ? rootKey : (note.key ?? rootKey),
    velocity: note.vel ?? DEFAULT_VELOCITY,
  }));
}

/** Two notes of a track that overlap (an 808 glides between them). */
function overlaps(track: BeatTrack): boolean {
  const sorted = [...track.notes].sort((a, b) => a.step - b.step);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const note = sorted[i]!;
    if (note.step > previous.step && previous.step + (previous.len ?? 1) > note.step + OVERLAP_EPSILON_STEPS)
      return true;
  }
  return false;
}

/** Whether anything still plays the sample. */
function sampleInUse(draft: Draft<Project>, sampleId: SampleId): boolean {
  for (const channelId of draft.channelOrder) {
    const channel = draft.channels[channelId];
    if (channel?.kind === 'audioClip' && channel.sampleId === sampleId) return true;
    if (channel?.kind === 'instrument' && Object.values(channel.plugin.samples ?? {}).includes(sampleId)) return true;
  }
  for (const insertId of draft.mixer.order) {
    for (const slot of draft.mixer.inserts[insertId]?.fx ?? []) {
      if (Object.values(slot.plugin.samples ?? {}).includes(sampleId)) return true;
    }
  }
  return false;
}

/** Gets the pattern the beat writes into (a new one, or the one being rewritten, emptied of what the beat wrote). */
function patternToWrite(draft: Draft<Project>, spec: BeatSpec, beat: BeatPlan) {
  const { patternId, reuse } = beat;
  const pattern = draft.patterns[patternId];
  if (!pattern) {
    addPattern(draft, makePattern(spec.title, paletteColor(draft.patternOrder.length + 3), patternId));
    return draft.patterns[patternId];
  }
  pattern.name = spec.title;
  // A rewrite replaces what the beat wrote there before.
  for (const id of Object.values(reuse?.channels ?? {})) delete pattern.notes[id];
  return pattern;
}

/** A new channel, and the sample it plays, into the draft. */
function addPlannedChannel(draft: Draft<Project>, planned: PlannedTrack): void {
  const { make, sample } = planned;
  if (!make) return;
  if (sample && !draft.samples[sample.id]) addSample(draft, sample);
  addChannel(draft, make);
}

/** Points a channel at another sample (the musician's own, or the style's kit) and drops the old kit sample if nothing uses it. */
function switchSample(draft: Draft<Project>, planned: PlannedTrack, channel: Draft<InstrumentChannel>): void {
  const { channelId, swap, kit } = planned;
  if (swap) {
    if (!draft.samples[swap.id]) addSample(draft, swap);
    setPluginSample(draft, { kind: 'channel', channelId }, 'main', swap.id);
    channel.name = swap.name;
  }
  if (kit) {
    const oldSampleId = channel.plugin.samples?.main as SampleId | undefined;
    if (!draft.samples[kit.id]) addSample(draft, kit);
    setPluginSample(draft, { kind: 'channel', channelId }, 'main', kit.id);
    if (oldSampleId && oldSampleId !== kit.id && !sampleInUse(draft, oldSampleId)) delete draft.samples[oldSampleId];
  }
}

/** The writer's setup of a drum Sampler channel: velocity tone, the open hat's envelope, the drum's level. */
function setUpDrumChannel(
  draft: Draft<Project>,
  services: Services,
  planned: PlannedTrack,
  channel: Draft<InstrumentChannel>,
  hasClosedHat: boolean,
): void {
  const { track, make } = planned;
  const definition = services.plugins.get(channel.plugin.pluginId);
  // Soft notes in rolls sound softer, not just quieter.
  if (definition?.params.velTone && !((channel.plugin.params.velTone as number) > 0)) {
    channel.plugin.params.velTone = DRUM_VELOCITY_TONE;
  }
  // An open hat stops when its note ends (the next closed hat).
  if (track.sound === 'open-hat' && hasClosedHat && definition?.params.envelope) {
    channel.plugin.params.envelope = true;
    channel.plugin.params.attack = OPEN_HAT_ENVELOPE.attack;
    channel.plugin.params.sustain = OPEN_HAT_ENVELOPE.sustain;
    channel.plugin.params.release = OPEN_HAT_ENVELOPE.release;
  }
  // A kit channel taken over at the default level gets its drum's level (for the kit it now plays).
  if (!make && channel.volume === DEFAULT_CHANNEL_VOLUME) {
    const sample = draft.samples[channel.plugin.samples?.main as SampleId];
    const piece = sample?.source.kind === 'builtin' ? kitPiece(sample.source.generator) : undefined;
    channel.volume = drumVolume(track.sound as KitSound, piece?.kit);
  }
}

/** The sound a channel the writer owns gets: a new instrument and preset, drum setup, the track's params and the 808's glide. */
function setUpOwnChannel(
  draft: Draft<Project>,
  services: Services,
  planned: PlannedTrack,
  channel: Draft<InstrumentChannel>,
  hasClosedHat: boolean,
): void {
  const { track } = planned;
  if (planned.sound) {
    const { def, params, state } = planned.sound;
    channel.plugin = {
      pluginId: def.id,
      pluginVersion: def.version,
      params,
      ...(state !== undefined ? { state } : {}),
      ...(channel.plugin.samples && def.sampleSlots?.length ? { samples: { ...channel.plugin.samples } } : {}),
    } as Draft<PluginInstance>;
  }
  if (DRUM_SOUNDS.has(track.sound) && channel.plugin.pluginId === SAMPLER_ID) {
    setUpDrumChannel(draft, services, planned, channel, hasClosedHat);
  }
  const definition = services.plugins.get(channel.plugin.pluginId);
  for (const [paramId, value] of Object.entries(track.params ?? {})) {
    const clamped = clampParam(definition?.params[paramId], value);
    if (clamped !== null) channel.plugin.params[paramId] = clamped;
  }
  if (channel.plugin.pluginId === BASS808_ID && overlaps(track)) {
    const glide = channel.plugin.params.glide;
    if (typeof glide !== 'number' || glide < MIN_GLIDE_SEC) channel.plugin.params.glide = MIN_GLIDE_SEC;
  }
}

/** Writes a planned beat into a draft (part of an undoable edit). */
export function writeBeat(services: Services, draft: Draft<Project>, spec: BeatSpec, beat: BeatPlan): void {
  if (spec.bpm !== undefined && spec.bpm !== draft.transport.bpm) setBpm(draft, spec.bpm);
  if (spec.swing !== undefined) setSwing(draft, spec.swing);
  const pattern = patternToWrite(draft, spec, beat);
  if (!pattern) return;
  pattern.stepCount = spec.bars * STEPS_PER_BAR;
  pattern.length = spec.bars * STEPS_PER_BAR * TICKS_PER_STEP;
  const hasClosedHat = spec.tracks.some((track) => track.sound === 'hat');
  for (const planned of beat.tracks) {
    const { track, channelId } = planned;
    addPlannedChannel(draft, planned);
    const channel = draft.channels[channelId];
    if (!channel || channel.kind !== 'instrument') continue;
    switchSample(draft, planned, channel);
    if (planned.own) setUpOwnChannel(draft, services, planned, channel, hasClosedHat);
    // Levels the beat sets apply to any channel it plays on.
    if (track.volume !== undefined) channel.volume = track.volume;
    if (track.pan !== undefined) channel.pan = track.pan;
    const notesById: Record<string, Note> = {};
    for (const note of notesFor(track, channel.rootKey)) notesById[note.id] = note;
    pattern.notes[channelId] = notesById as never;
  }
}
