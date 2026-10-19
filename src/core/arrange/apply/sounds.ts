import type { Draft } from 'immer';
import { fxLabel, fxName, fxSampleRef, type FxKind } from '../../model/fx';
import { newId } from '../../model/ids';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type ChannelId,
  type ClipId,
  type Project,
  type SampleRef,
} from '../../model/types';
import { PPQ } from '../../time/ppq';
import { addClips } from '../../ops/playlist';
import type { PlannedCrash, PlannedFx } from '../plan';
import { DEFAULT_CRASH_SECONDS } from '../plan/crashes';
import { laneNamed } from './lanes';
import type { ApplyEnv } from './types';

/** The name of the audio clip channel that plays crash hits. */
export const CRASH_CHANNEL_NAME = 'Crash hits';
/** A clip's gain is capped at +12 dB. */
const MAX_CLIP_GAIN = 4;
/** Channel colours and levels of the arranger's sounds. */
const FX_CHANNEL_COLOR = '#8c9aa8';
const FX_CHANNEL_VOLUME = 0.7;
const CRASH_CHANNEL_COLOR = '#c9a24a';
const DEFAULT_CRASH_VOLUME = 0.55;

const dbGain = (db: number) => Math.min(MAX_CLIP_GAIN, Math.pow(10, db / 20));

/** An audio clip channel's bus: the given insert when it exists, else the master. */
const outputOr = (d: Draft<Project>, insertId: ApplyEnv['fxOutput']) =>
  insertId && d.mixer.inserts[insertId] ? insertId : MASTER;

/** The audio clip channel playing an FX sound (one per sound, reused). */
function fxChannel(d: Draft<Project>, kind: FxKind, beats: number, bpm: number, env: ApplyEnv): ChannelId {
  const generator = fxName(kind, beats, bpm);
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (ch?.kind !== 'audioClip') continue;
    const src = d.samples[ch.sampleId]?.source;
    if (src?.kind === 'builtin' && src.generator === generator) return cid;
  }
  const ref = fxSampleRef(kind, beats, bpm);
  d.samples[ref.id] = ref;
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: fxLabel(kind, beats),
    color: FX_CHANNEL_COLOR,
    muted: false,
    solo: false,
    volume: FX_CHANNEL_VOLUME,
    pan: 0,
    output: outputOr(d, env.fxOutput),
    sampleId: ref.id,
    stretch: 'resample',
    sourceBpm: bpm,
  };
  d.channels[channel.id] = channel;
  d.channelOrder.push(channel.id);
  return channel.id;
}

/** The audio clip channel that plays crash hits (made on first use). */
function crashChannel(d: Draft<Project>, env: ApplyEnv): ChannelId {
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (ch?.kind === 'audioClip' && ch.name === CRASH_CHANNEL_NAME) return cid;
  }
  const ref: SampleRef = env.crash?.sample ?? {
    id: newId.sample(),
    name: 'Crash',
    source: { kind: 'builtin', generator: 'kit/crash', version: 1 },
  };
  if (!d.samples[ref.id]) d.samples[ref.id] = ref;
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: CRASH_CHANNEL_NAME,
    color: CRASH_CHANNEL_COLOR,
    muted: false,
    solo: false,
    volume: env.crash?.volume ?? DEFAULT_CRASH_VOLUME,
    pan: 0,
    output: outputOr(d, env.crash?.output),
    sampleId: ref.id,
  };
  d.channels[channel.id] = channel;
  d.channelOrder.push(channel.id);
  return channel.id;
}

/** Writes the planned FX sounds as audio clips on their lanes; returns the clip ids. */
export function placeFx(d: Draft<Project>, items: readonly PlannedFx[], env: ApplyEnv): ClipId[] {
  const bpm = d.transport.bpm;
  const out: ClipId[] = [];
  for (const f of items) {
    const channelId = fxChannel(d, f.kind, f.beats, bpm, env);
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId: laneNamed(d, f.lane),
      start: Math.max(0, Math.round(f.start)),
      length: Math.max(1, Math.round(f.length)),
      channelId,
      offsetSec: 0,
    };
    const gain = dbGain(f.gainDb);
    if (Math.abs(gain - 1) > 1e-9) clip.gain = gain;
    addClips(d, [clip]);
    out.push(clip.id);
  }
  return out;
}

/** Writes the planned crash hits as audio clips on their lanes; returns the clip ids. */
export function placeCrashes(d: Draft<Project>, items: readonly PlannedCrash[], env: ApplyEnv): ClipId[] {
  if (!items.length) return [];
  const channelId = crashChannel(d, env);
  const ch = d.channels[channelId] as Draft<AudioClipChannel>;
  const ref = d.samples[ch.sampleId] as SampleRef | undefined;
  const seconds = (ref && env.sampleSeconds?.(ref)) ?? DEFAULT_CRASH_SECONDS;
  const ticks = Math.max(1, Math.round((seconds * d.transport.bpm * PPQ) / 60));
  const out: ClipId[] = [];
  for (const c of items) {
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId: laneNamed(d, c.lane),
      start: Math.max(0, Math.round(c.at)),
      length: ticks,
      channelId,
      offsetSec: 0,
    };
    if (Math.abs(c.velocity - 1) > 1e-9) clip.gain = Math.max(0, Math.min(1, c.velocity));
    addClips(d, [clip]);
    out.push(clip.id);
  }
  return out;
}
