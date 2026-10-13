import type { Draft } from 'immer';
import type { ParamSpec } from '@agstudio/sdk/params';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import { DRUM_SOUNDS, type BeatSound, type BeatSpec, type BeatTrack } from '@core/beat/spec';
import { makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ChannelId, InstrumentChannel, Note, PatternId, Project, SampleRef } from '@core/model/types';
import { addChannel, addSample, setPluginSample } from '@core/ops/channels';
import { setBpm, setSwing } from '@core/ops/notes';
import { addPattern } from '@core/ops/playlist';
import { TICKS_PER_STEP } from '@core/time/ppq';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../default-project';
import type { Services } from '../services';

/** Where an applied beat lives, so follow-up requests can change it in place. */
export interface AppliedBeat {
  patternId: PatternId;
  /** Track name (lowercase) → channel. */
  channels: Record<string, ChannelId>;
  /** Channels the assistant created (it may set their sound); the rest were already in the project. */
  created: ChannelId[];
}

export const BASS808_ID = 'agstudio.bass808';
const THREE_OSC_ID = 'agstudio.3xosc';
const PLUCK_ID = 'agstudio.pluck';

const KIT: Partial<Record<BeatSound, string>> = {
  kick: 'kit/kick',
  snare: 'kit/snare',
  clap: 'kit/clap',
  hat: 'kit/hat-closed',
  'open-hat': 'kit/hat-open',
  'tom-low': 'kit/tom-low',
  'tom-mid': 'kit/tom-mid',
  'tom-high': 'kit/tom-high',
  rim: 'kit/rim',
  cowbell: 'kit/cowbell',
  crash: 'kit/crash',
};

/** 3xOsc settings for the synth sounds (and the 808 when the 808 plugin isn't installed). */
const SYNTH: Partial<Record<BeatSound, Record<string, number | string>>> = {
  bass: { osc1Coarse: -12, osc2Coarse: -12, attack: 0.002, decay: 0.25, sustain: 0.3, cutoff: 600, filterEnv: 2.5 },
  lead: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.25, cutoff: 3200, osc3Level: 0.2 },
  pad: { attack: 0.6, decay: 1.2, sustain: 0.8, release: 1.5, cutoff: 1800, filterEnv: 0.6, osc3Level: 0.2 },
  '808': {
    osc1Wave: 'sine',
    osc2Level: 0,
    osc3Wave: 'sine',
    osc3Coarse: 0,
    osc3Level: 0,
    attack: 0.002,
    decay: 2,
    sustain: 0.2,
    release: 0.15,
    cutoff: 900,
    filterEnv: 0,
  },
};

/** Channel volumes for new pitched parts that sit under the drums (kit channels keep 0.78). */
const DEFAULT_VOLUME: Partial<Record<BeatSound, number>> = {
  '808': 0.62,
  bass: 0.62,
  pad: 0.45,
  lead: 0.55,
  pluck: 0.6,
};

function clampParam(spec: ParamSpec | undefined, v: number): number | null {
  if (!spec || (spec.type !== 'float' && spec.type !== 'int')) return null;
  const x = Math.min(spec.max, Math.max(spec.min, v));
  return spec.type === 'int' ? Math.round(x) : x;
}

function pluginFor(s: Services, sound: BeatSound): PluginDef | undefined {
  if (KIT[sound]) return s.plugins.get(SAMPLER_ID);
  if (sound === '808') return s.plugins.get(BASS808_ID) ?? s.plugins.get(THREE_OSC_ID);
  if (sound === 'pluck') return s.plugins.get(PLUCK_ID) ?? s.plugins.get(THREE_OSC_ID);
  return s.plugins.get(THREE_OSC_ID);
}

/** An existing channel playing the same sound (the project's Kick, its 808, …), for drums and 808s. */
function existingChannel(p: Project, sound: BeatSound, taken: ReadonlySet<ChannelId>): ChannelId | undefined {
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    if (!ch || ch.kind !== 'instrument' || taken.has(id)) continue;
    if (KIT[sound] && ch.plugin.pluginId === SAMPLER_ID) {
      const ref = p.samples[ch.plugin.samples?.main as keyof Project['samples']];
      if (ref?.source.kind === 'builtin' && ref.source.generator === KIT[sound]) return id;
    }
    if (sound === '808' && ch.plugin.pluginId === BASS808_ID) return id;
  }
  return undefined;
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

/**
 * Writes a beat into the project as one undo step: a new pattern (or the previous one, for
 * follow-ups), channels for its tracks (reusing the project's matching drum and 808 channels) and
 * their notes. Selects the pattern so the rack and piano roll show it.
 */
export interface ApplyOptions {
  /** Samples to play instead of the kit for these sounds ("use my sounds"); they get their own channels. */
  samples?: Partial<Record<BeatSound, SampleRef>>;
}

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

/** Where each track of a beat goes (decided before the edit: new channels are built outside the recipe). */
export interface BeatPlan {
  patternId: PatternId;
  reuse: AppliedBeat | null;
  channels: Record<string, ChannelId>;
  created: Set<ChannelId>;
  tracks: {
    track: BeatTrack;
    channelId: ChannelId;
    make?: InstrumentChannel;
    sample?: SampleRef;
    /** A sampler channel of the assistant's that now plays this sample. */
    swap?: SampleRef;
  }[];
}

/** Selects the beat's pattern and first channel; returns where the beat lives (for follow-ups). */
export function showBeat(s: Services, plan: BeatPlan): AppliedBeat {
  s.view.getState().setCurrentPattern(plan.patternId);
  const first = Object.values(plan.channels)[0];
  if (first) s.session.getState().selectChannel(first);
  return { patternId: plan.patternId, channels: plan.channels, created: [...plan.created] };
}

/**
 * Plans a beat against a project (or a draft of one, inside a larger edit): which channels its tracks
 * reuse and which it creates.
 */
export function planBeat(
  s: Services,
  project: Project,
  spec: BeatSpec,
  previous?: AppliedBeat | null,
  opts: ApplyOptions = {},
): BeatPlan {
  const reuse = previous && project.patterns[previous.patternId] ? previous : null;
  const patternId = reuse?.patternId ?? newId.pattern();
  const channels: Record<string, ChannelId> = {};
  const created = new Set(reuse?.created ?? []);
  const taken = new Set<ChannelId>();

  // Decide every track's channel first (new channels are built outside the recipe).
  const plan: {
    track: BeatTrack;
    channelId: ChannelId;
    make?: InstrumentChannel;
    sample?: SampleRef;
    /** A sampler channel of the assistant's that now plays this sample. */
    swap?: SampleRef;
  }[] = [];
  let index = project.channelOrder.length;
  const sampler = s.plugins.get(SAMPLER_ID);
  for (const track of spec.tracks) {
    const key = track.name.toLowerCase();
    const prior = reuse?.channels[key];
    const own = opts.samples?.[track.sound];
    if (own && sampler) {
      const mine = prior && created.has(prior) && !taken.has(prior) ? project.channels[prior] : undefined;
      if (prior && mine?.kind === 'instrument' && mine.plugin.pluginId === SAMPLER_ID) {
        taken.add(prior);
        channels[key] = prior;
        plan.push({ track, channelId: prior, swap: own });
      } else {
        const ch = instrumentChannelFor(sampler, own.name, index++, { main: own.id });
        created.add(ch.id);
        taken.add(ch.id);
        channels[key] = ch.id;
        plan.push({ track, channelId: ch.id, make: ch, sample: own });
      }
      continue;
    }
    let channelId = prior && project.channels[prior] && !taken.has(prior) ? prior : undefined;
    channelId ??= existingChannel(project, track.sound, taken);
    if (channelId) {
      taken.add(channelId);
      channels[key] = channelId;
      plan.push({ track, channelId });
      continue;
    }
    const def = pluginFor(s, track.sound);
    if (!def) continue;
    const kit = KIT[track.sound];
    const sample = kit ? kitSampleRef(kit) : undefined;
    const ch = instrumentChannelFor(def, track.name, index++, sample ? { main: sample.id } : undefined);
    const preset = def.id === THREE_OSC_ID ? SYNTH[track.sound] : undefined;
    if (preset) ch.plugin.params = { ...defaultValues(def.params), ...preset };
    created.add(ch.id);
    taken.add(ch.id);
    channels[key] = ch.id;
    plan.push({ track, channelId: ch.id, make: ch, ...(sample ? { sample } : {}) });
  }

  return { patternId, reuse, channels, created, tracks: plan };
}

/** Writes a planned beat into a draft (part of an undoable edit). */
export function writeBeat(s: Services, d: Draft<Project>, spec: BeatSpec, beat: BeatPlan): void {
  const { patternId, reuse, created } = beat;
  const plan = beat.tracks;
  {
    if (spec.bpm !== undefined && spec.bpm !== d.transport.bpm) setBpm(d, spec.bpm);
    if (spec.swing !== undefined) setSwing(d, spec.swing);
    let pattern = d.patterns[patternId];
    if (!pattern) {
      addPattern(d, makePattern(spec.title, paletteColor(d.patternOrder.length + 3), patternId));
      pattern = d.patterns[patternId];
    } else {
      pattern.name = spec.title;
      // A follow-up replaces what the assistant wrote before.
      for (const id of Object.values(reuse?.channels ?? {})) delete pattern.notes[id];
    }
    if (!pattern) return;
    pattern.stepCount = spec.bars * 16;
    pattern.length = spec.bars * 16 * TICKS_PER_STEP;
    for (const { track, channelId, make, sample, swap } of plan) {
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
      // Only the assistant's own channels take its mix and sound settings.
      if (created.has(channelId)) {
        if (track.volume !== undefined) ch.volume = track.volume;
        // Headroom: at full channel volume an 808 or pad on top of the drums clips the master.
        else if (make && DEFAULT_VOLUME[track.sound] !== undefined) ch.volume = DEFAULT_VOLUME[track.sound] as number;
        if (track.pan !== undefined) ch.pan = track.pan;
        const def = s.plugins.get(ch.plugin.pluginId);
        for (const [k, v] of Object.entries(track.params ?? {})) {
          const x = clampParam(def?.params[k], v);
          if (x !== null) ch.plugin.params[k] = x;
        }
      }
      const byId: Record<string, Note> = {};
      for (const n of notesFor(track, ch.rootKey)) byId[n.id] = n;
      pattern.notes[channelId] = byId as never;
    }
  }
}
