/**
 * The beat writer: turns a beat (`core/beat/spec`) into a pattern and its channels, inside one
 * undoable edit. Channels are shared like FL patterns share them: a track reuses the channel of the
 * same name, the project's kit channel for its drum or its 808. New channels get the style's sound
 * (the palette) and drum kit; the writer changes the sound only of channels it made itself or kit
 * channels still at their defaults, while levels the beat sets apply to any channel.
 */
import type { Draft } from 'immer';
import type { ParamSpec } from '@agstudio/sdk/params';
import { defaultValues, type ParamValue, type PluginDef } from '@agstudio/sdk';
import { styleOfBeat } from '@core/beat/groove';
import { DRUM_SOUNDS, type BeatSound, type BeatSpec, type BeatTrack } from '@core/beat/spec';
import type { Style } from '@core/beat/style';
import { DEFAULT_CHANNEL_VOLUME, makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { kitPiece, kitPieceFor, type KitSound } from '@core/model/kit';
import type { ChannelId, InstrumentChannel, Note, PatternId, PluginInstance, Project, SampleId, SampleRef } from '@core/model/types';
import { addChannel, addSample, setPluginSample } from '@core/ops/channels';
import { setBpm, setSwing } from '@core/ops/notes';
import { addPattern } from '@core/ops/playlist';
import { TICKS_PER_STEP } from '@core/time/ppq';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../default-project';
import { presetChoices, presetValues, type PresetChoice } from '../presets';
import type { Services } from '../services';
import { BASS808_ID, DRUM_VOLUME, KIT_FOR, SYNTH as SYNTH_SETTINGS, soundFor } from './palette';

export { BASS808_ID };

/** 3xOsc settings for the synth sounds (the MIDI import uses them too). */
export const SYNTH: Partial<Record<BeatSound, Record<string, number | string>>> = SYNTH_SETTINGS;

/** Where an applied beat lives, so follow-up requests can change it in place. */
export interface AppliedBeat {
  patternId: PatternId;
  /** Track name (lowercase) → channel. */
  channels: Record<string, ChannelId>;
  /** Channels the assistant created (it may set their sound); the rest were already in the project. */
  created: ChannelId[];
}

export interface ApplyOptions {
  /** Samples to play instead of the kit for these sounds ("use my sounds"); they get their own channels. */
  samples?: Partial<Record<BeatSound, SampleRef>>;
  /** Rewrite this pattern (a beat names one) rather than the previous beat's or a new one. */
  patternId?: PatternId;
  /** Channels the assistant made earlier (in this answer or conversation): it may set their sound too. */
  own?: Iterable<ChannelId>;
}

/** One track's channel, decided before the edit (new channels are built outside the recipe). */
export interface PlannedTrack {
  track: BeatTrack;
  channelId: ChannelId;
  make?: InstrumentChannel;
  sample?: SampleRef;
  /** A sampler channel of the assistant's that now plays this sample ("use my sounds"). */
  swap?: SampleRef;
  /** A kit channel still at its defaults switches to the style's kit sample. */
  kit?: SampleRef;
  /** The writer may set this channel's sound (its own channel, or a kit channel at its defaults). */
  own: boolean;
  /** A new instrument and preset for an own channel (the track names a preset). */
  sound?: { def: PluginDef; params: Record<string, ParamValue>; state: unknown };
}

/** Where each track of a beat goes. */
export interface BeatPlan {
  patternId: PatternId;
  reuse: AppliedBeat | null;
  channels: Record<string, ChannelId>;
  created: Set<ChannelId>;
  /** The style the beat is written in (its own, or guessed from its tempo, swing and kick). */
  style: Style;
  /** Channels whose level (volume or pan) the beat set: the mix setup leaves those alone. */
  levels: Set<ChannelId>;
  /** Presets that weren't found, and the like. */
  warnings: string[];
  tracks: PlannedTrack[];
}

/** Writes a beat into the project as one undo step (see `planBeat`) and selects it. */
export function applyBeatSpec(
  s: Services,
  spec: BeatSpec,
  previous?: AppliedBeat | null,
  opts: ApplyOptions = {},
): AppliedBeat {
  const plan = planBeat(s, s.doc.getState().project, spec, previous, opts);
  s.history.transact(`Assistant: ${spec.title}`, (d) => writeBeat(s, d, spec, plan));
  return showBeat(s, plan);
}

/** Selects the beat's pattern and first channel; returns where the beat lives (for follow-ups). */
export function showBeat(s: Services, plan: BeatPlan): AppliedBeat {
  s.view.getState().setCurrentPattern(plan.patternId);
  // The first track's (not the first key's: "808" would sort before "kick").
  const first = plan.tracks[0]?.channelId ?? Object.values(plan.channels)[0];
  if (first) s.session.getState().selectChannel(first);
  return { patternId: plan.patternId, channels: plan.channels, created: [...plan.created] };
}

// ---------------------------------------------------------------- reading channels

const lower = (x: string) => x.trim().toLowerCase();

/** The kit piece a sampler channel plays (stock or genre kit), if any. */
function kitOf(p: Project, ch: InstrumentChannel) {
  if (ch.plugin.pluginId !== SAMPLER_ID) return undefined;
  const ref = p.samples[ch.plugin.samples?.main as SampleId];
  return ref?.source.kind === 'builtin' ? kitPiece(ref.source.generator) : undefined;
}

/** Whether a channel can play a track of `sound`: drums need a Sampler, pitched parts any other instrument. */
function fits(p: Project, ch: InstrumentChannel, sound: BeatSound): boolean {
  if (DRUM_SOUNDS.has(sound)) return ch.plugin.pluginId === SAMPLER_ID;
  return !kitOf(p, ch) && ch.plugin.pluginId !== SAMPLER_ID;
}

/** Sampler params the writer manages on drum channels (velocity tone, the open hat's envelope). */
const WRITER_PARAMS = new Set(['velTone', 'envelope', 'attack', 'decay', 'sustain', 'release']);

/** A channel nobody has tuned: every param at its default (but the ones the writer sets itself). */
function atDefaults(ch: InstrumentChannel, def: PluginDef | undefined): boolean {
  if (!def) return false;
  const defaults = defaultValues(def.params);
  return Object.entries(defaults).every(([k, v]) => WRITER_PARAMS.has(k) || (ch.plugin.params[k] ?? v) === v);
}

/** Whether the channel plays in a pattern other than `patternId`. */
function playsElsewhere(p: Project, id: ChannelId, patternId: PatternId): boolean {
  for (const pid of p.patternOrder) {
    if (pid === patternId) continue;
    const notes = p.patterns[pid]?.notes[id];
    if (notes && Object.keys(notes).length) return true;
  }
  return false;
}

/** An existing channel playing the same drum (the style's kit sample first) or the project's 808. */
function existingChannel(
  p: Project,
  sound: BeatSound,
  taken: ReadonlySet<ChannelId>,
  style: Style,
): ChannelId | undefined {
  const want = DRUM_SOUNDS.has(sound) ? kitPieceFor(sound as KitSound, KIT_FOR[style])?.generator : undefined;
  let fallback: ChannelId | undefined;
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    if (!ch || ch.kind !== 'instrument' || taken.has(id)) continue;
    if (sound === '808' && ch.plugin.pluginId === BASS808_ID) return id;
    const piece = kitOf(p, ch);
    if (!piece || piece.sound !== sound) continue;
    if (piece.generator === want) return id;
    fallback ??= id;
  }
  return fallback;
}

/** The channel of the same name that can play the track. */
function namedChannel(p: Project, name: string, sound: BeatSound, taken: ReadonlySet<ChannelId>): ChannelId | undefined {
  const key = lower(name);
  return p.channelOrder.find((id) => {
    const ch = p.channels[id];
    return ch?.kind === 'instrument' && !taken.has(id) && lower(ch.name) === key && fits(p, ch, sound);
  });
}

/** The pattern's channels by (lowercase) name, for rewriting a pattern a beat names. */
function patternChannels(p: Project, patternId: PatternId): Record<string, ChannelId> {
  const out: Record<string, ChannelId> = {};
  const notes = p.patterns[patternId]?.notes ?? {};
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    if (ch && Object.keys(notes[id] ?? {}).length) out[lower(ch.name)] ??= id;
  }
  return out;
}

// ---------------------------------------------------------------- sounds

function findPreset(s: Services, def: PluginDef, name: string): PresetChoice | undefined {
  // The musician's own presets first (they name them), then the factory ones.
  return presetChoices(def, s.presets)
    .reverse()
    .find((p) => lower(p.name) === lower(name));
}

/** The instrument, settings and level a new pitched channel gets: a named preset, else the palette. */
function pickSound(
  s: Services,
  style: Style,
  track: BeatTrack,
  warnings: string[],
): { def: PluginDef; params: Record<string, ParamValue>; state: unknown; volume: number; rootKey?: number } | null {
  const choices = soundFor(style, track.sound);
  if (track.preset) {
    const defs = [
      ...choices.map((c) => s.plugins.get(c.pluginId)).filter((d): d is PluginDef => !!d),
      ...s.plugins.list('instrument').map((e) => e.def),
    ];
    for (const def of defs) {
      const preset = findPreset(s, def, track.preset);
      if (!preset) continue;
      const values = presetValues(def, preset);
      return { def, params: values.params, state: values.state, volume: choices[0]?.volume ?? DEFAULT_CHANNEL_VOLUME };
    }
    warnings.push(`beat: no instrument has a preset “${track.preset}”, so “${track.name}” plays the ${style} sound`);
  }
  for (const c of choices) {
    const def = s.plugins.get(c.pluginId);
    if (!def) continue;
    const preset = c.preset ? findPreset(s, def, c.preset) : undefined;
    const values = preset ? presetValues(def, preset) : { params: defaultValues(def.params), state: undefined };
    for (const [k, v] of Object.entries(c.params ?? {})) if (def.params[k]) values.params[k] = v;
    return { def, params: values.params, state: values.state, volume: c.volume, ...(c.rootKey !== undefined ? { rootKey: c.rootKey } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------- planning

/**
 * Plans a beat against a project (or a draft of one, inside a larger edit): which pattern it
 * writes, which channels its tracks reuse and which it creates.
 */
export function planBeat(
  s: Services,
  project: Project,
  spec: BeatSpec,
  previous?: AppliedBeat | null,
  opts: ApplyOptions = {},
): BeatPlan {
  const style =
    spec.style ??
    styleOfBeat(spec.tracks, spec.bars, spec.bpm ?? project.transport.bpm, spec.swing ?? project.transport.swing);
  const named = opts.patternId && project.patterns[opts.patternId] ? opts.patternId : undefined;
  const fromPrevious = previous && project.patterns[previous.patternId] ? previous : null;
  // A pattern the beat names: rewrite it, with the previous beat's channels if it is that beat.
  const reuse: AppliedBeat | null = named
    ? fromPrevious?.patternId === named
      ? fromPrevious
      : { patternId: named, channels: patternChannels(project, named), created: [] }
    : fromPrevious;
  const patternId = reuse?.patternId ?? newId.pattern();
  const channels: Record<string, ChannelId> = {};
  const created = new Set<ChannelId>([...(reuse?.created ?? []), ...(opts.own ?? [])]);
  const taken = new Set<ChannelId>();
  const levels = new Set<ChannelId>();
  const warnings: string[] = [];
  const plan: PlannedTrack[] = [];
  let index = project.channelOrder.length;
  const sampler = s.plugins.get(SAMPLER_ID);

  for (const track of spec.tracks) {
    const key = lower(track.name);
    const drum = DRUM_SOUNDS.has(track.sound);
    const prior = reuse?.channels[key];
    const own = opts.samples?.[track.sound];
    if (own && sampler) {
      const mine = prior && created.has(prior) && !taken.has(prior) ? project.channels[prior] : undefined;
      if (prior && mine?.kind === 'instrument' && mine.plugin.pluginId === SAMPLER_ID) {
        taken.add(prior);
        channels[key] = prior;
        plan.push({ track, channelId: prior, swap: own, own: true });
      } else {
        const ch = instrumentChannelFor(sampler, own.name, index++, { main: own.id });
        created.add(ch.id);
        taken.add(ch.id);
        channels[key] = ch.id;
        plan.push({ track, channelId: ch.id, make: ch, sample: own, own: true });
      }
      continue;
    }

    const priorCh = prior ? project.channels[prior] : undefined;
    let channelId =
      prior && priorCh?.kind === 'instrument' && !taken.has(prior) && fits(project, priorCh, track.sound) ? prior : undefined;
    channelId ??= namedChannel(project, track.name, track.sound, taken);
    channelId ??= drum || track.sound === '808' ? existingChannel(project, track.sound, taken, style) : undefined;
    if (channelId) {
      taken.add(channelId);
      channels[key] = channelId;
      const ch = project.channels[channelId] as InstrumentChannel;
      const planned: PlannedTrack = { track, channelId, own: created.has(channelId) };
      // A kit channel nobody has tuned or used elsewhere plays the style's kit and takes the writer's setup.
      const piece = drum ? kitOf(project, ch) : undefined;
      if (piece && atDefaults(ch, sampler) && !playsElsewhere(project, channelId, patternId)) {
        planned.own = true;
        const want = kitPieceFor(track.sound as KitSound, KIT_FOR[style]);
        if (want && want.generator !== piece.generator) planned.kit = kitSampleRef(want.generator);
      }
      if (planned.own && !drum && track.preset) {
        const sound = pickSound(s, style, track, warnings);
        if (sound && (sound.def.id !== ch.plugin.pluginId || track.preset))
          planned.sound = { def: sound.def, params: sound.params, state: sound.state };
      }
      plan.push(planned);
      continue;
    }

    // A new channel: the style's kit sample, or the palette's instrument.
    if (drum) {
      if (!sampler) continue;
      const piece = kitPieceFor(track.sound as KitSound, KIT_FOR[style]);
      if (!piece) continue;
      const sample = kitSampleRef(piece.generator);
      const ch = instrumentChannelFor(sampler, track.name, index++, { main: sample.id });
      ch.volume = DRUM_VOLUME[track.sound as KitSound];
      created.add(ch.id);
      taken.add(ch.id);
      channels[key] = ch.id;
      plan.push({ track, channelId: ch.id, make: ch, sample, own: true });
      continue;
    }
    const sound = pickSound(s, style, track, warnings);
    if (!sound) continue;
    const ch = instrumentChannelFor(sound.def, track.name, index++);
    ch.plugin.params = sound.params;
    if (sound.state !== undefined) ch.plugin.state = sound.state as never;
    ch.volume = sound.volume;
    if (sound.rootKey !== undefined) ch.rootKey = sound.rootKey;
    created.add(ch.id);
    taken.add(ch.id);
    channels[key] = ch.id;
    plan.push({ track, channelId: ch.id, make: ch, own: true });
  }
  for (const p of plan) if (p.track.volume !== undefined || p.track.pan !== undefined) levels.add(p.channelId);

  return { patternId, reuse, channels, created, style, levels, warnings, tracks: plan };
}

// ---------------------------------------------------------------- writing

function clampParam(spec: ParamSpec | undefined, v: number): number | null {
  if (!spec || (spec.type !== 'float' && spec.type !== 'int')) return null;
  const x = Math.min(spec.max, Math.max(spec.min, v));
  return spec.type === 'int' ? Math.round(x) : x;
}

function notesFor(track: BeatTrack, rootKey: number): Note[] {
  const drum = DRUM_SOUNDS.has(track.sound);
  return track.notes.map((n) => ({
    id: newId.note(),
    tick: Math.round(n.step * TICKS_PER_STEP),
    length: Math.max(10, Math.round((n.len ?? 1) * TICKS_PER_STEP)),
    key: drum ? rootKey : (n.key ?? rootKey),
    velocity: n.vel ?? 0.8,
  }));
}

/** Two notes of a track that overlap (an 808 glides between them). */
function overlaps(track: BeatTrack): boolean {
  const sorted = [...track.notes].sort((a, b) => a.step - b.step);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b.step > a.step && a.step + (a.len ?? 1) > b.step + 1e-9) return true;
  }
  return false;
}

/** Whether anything still plays the sample. */
function sampleInUse(d: Draft<Project>, id: SampleId): boolean {
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (ch?.kind === 'audioClip' && ch.sampleId === id) return true;
    if (ch?.kind === 'instrument' && Object.values(ch.plugin.samples ?? {}).includes(id)) return true;
  }
  for (const iid of d.mixer.order)
    for (const slot of d.mixer.inserts[iid]?.fx ?? []) if (Object.values(slot.plugin.samples ?? {}).includes(id)) return true;
  return false;
}

/** The slide floor: overlapping 808 notes glide audibly (at least 60 ms). */
const MIN_GLIDE = 0.06;

/** Writes a planned beat into a draft (part of an undoable edit). */
export function writeBeat(s: Services, d: Draft<Project>, spec: BeatSpec, beat: BeatPlan): void {
  const { patternId, reuse } = beat;
  if (spec.bpm !== undefined && spec.bpm !== d.transport.bpm) setBpm(d, spec.bpm);
  if (spec.swing !== undefined) setSwing(d, spec.swing);
  let pattern = d.patterns[patternId];
  if (!pattern) {
    addPattern(d, makePattern(spec.title, paletteColor(d.patternOrder.length + 3), patternId));
    pattern = d.patterns[patternId];
  } else {
    pattern.name = spec.title;
    // A rewrite replaces what the beat wrote there before.
    for (const id of Object.values(reuse?.channels ?? {})) delete pattern.notes[id];
  }
  if (!pattern) return;
  pattern.stepCount = spec.bars * 16;
  pattern.length = spec.bars * 16 * TICKS_PER_STEP;
  const hasClosedHat = spec.tracks.some((t) => t.sound === 'hat');
  for (const planned of beat.tracks) {
    const { track, channelId, make, sample, swap, kit } = planned;
    if (make) {
      if (sample && !d.samples[sample.id]) addSample(d, sample);
      addChannel(d, make);
    }
    const ch = d.channels[channelId];
    if (!ch || ch.kind !== 'instrument') continue;
    if (swap) {
      if (!d.samples[swap.id]) addSample(d, swap);
      setPluginSample(d, { kind: 'channel', channelId }, 'main', swap.id);
      ch.name = swap.name;
    }
    if (kit) {
      const old = ch.plugin.samples?.main as SampleId | undefined;
      if (!d.samples[kit.id]) addSample(d, kit);
      setPluginSample(d, { kind: 'channel', channelId }, 'main', kit.id);
      if (old && old !== kit.id && !sampleInUse(d, old)) delete d.samples[old];
    }
    if (planned.own) {
      if (planned.sound) {
        const { def, params, state } = planned.sound;
        ch.plugin = {
          pluginId: def.id,
          pluginVersion: def.version,
          params,
          ...(state !== undefined ? { state } : {}),
          ...(ch.plugin.samples && def.sampleSlots?.length ? { samples: { ...ch.plugin.samples } } : {}),
        } as Draft<PluginInstance>;
      }
      const def = s.plugins.get(ch.plugin.pluginId);
      if (DRUM_SOUNDS.has(track.sound) && ch.plugin.pluginId === SAMPLER_ID) {
        // Soft notes in rolls sound softer, not just quieter.
        if (def?.params.velTone && !((ch.plugin.params.velTone as number) > 0)) ch.plugin.params.velTone = 0.5;
        // An open hat stops when its note ends (the next closed hat, see core/beat/groove.ts).
        if (track.sound === 'open-hat' && hasClosedHat && def?.params.envelope) {
          ch.plugin.params.envelope = true;
          ch.plugin.params.attack = 0.001;
          ch.plugin.params.sustain = 1;
          ch.plugin.params.release = 0.05;
        }
        // A kit channel taken over at the default level gets its drum's level.
        if (!make && ch.volume === DEFAULT_CHANNEL_VOLUME) ch.volume = DRUM_VOLUME[track.sound as KitSound];
      }
      for (const [k, v] of Object.entries(track.params ?? {})) {
        const x = clampParam(def?.params[k], v);
        if (x !== null) ch.plugin.params[k] = x;
      }
      if (ch.plugin.pluginId === BASS808_ID && overlaps(track)) {
        const glide = ch.plugin.params.glide;
        if (typeof glide !== 'number' || glide < MIN_GLIDE) ch.plugin.params.glide = MIN_GLIDE;
      }
    }
    // Levels the beat sets apply to any channel it plays on.
    if (track.volume !== undefined) ch.volume = track.volume;
    if (track.pan !== undefined) ch.pan = track.pan;
    const byId: Record<string, Note> = {};
    for (const n of notesFor(track, ch.rootKey)) byId[n.id] = n;
    pattern.notes[channelId] = byId as never;
  }
}
