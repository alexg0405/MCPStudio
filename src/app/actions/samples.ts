import { decodePcm } from '@core/io/wav';
import { newId } from '@core/model/ids';
import { fxSeconds, parseFxName } from '@core/model/fx';
import { kitPiece } from '@core/model/kit';
import type { AudioClip, AudioClipChannel, ChannelId, LaneId, PluginOwner, SampleRef, Tick } from '@core/model/types';
import { DEFAULT_CHANNEL_VOLUME, paletteColor } from '@core/model/defaults';
import { addChannel, addSample, setPluginSample } from '@core/ops/channels';
import { addClips } from '@core/ops/playlist';
import { tempoMapOf } from '@core/automation/tempo';
import { generate } from '@engine/kit/generators';
import type { Services } from '../services';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../default-project';
import { importSampleBytes } from '../persistence/sample-import';
import { AUDIO_EXTENSIONS, uploadFile } from '@platform/fs-access';

// User-level sample actions: kit sounds and audio files as sampler channels and playlist clips.

const durations = new Map<string, number>();

/** Length of a built-in kit sound in seconds (generated once at 48 kHz; FX sounds say it in their name). */
export function kitDuration(generator: string): number {
  const fx = parseFxName(generator);
  if (fx) return fxSeconds(fx);
  let d = durations.get(generator);
  if (d === undefined) {
    const data = generate(generator, 48000);
    d = data ? (data[0]?.length ?? 0) / 48000 : 0;
    durations.set(generator, d);
  }
  return d;
}

export interface AudioFacts {
  durationSec: number;
  /** The file's own rate when the PCM parser read it (decodeAudioData doesn't report it). */
  sampleRate?: number;
  channels: number;
}

/** Duration and layout of an audio file, or null when it can't be decoded. */
export async function probeAudio(bytes: Uint8Array): Promise<AudioFacts | null> {
  try {
    const pcm = decodePcm(bytes);
    const length = pcm?.channels[0]?.length ?? 0;
    if (pcm && length > 0)
      return { durationSec: length / pcm.sampleRate, sampleRate: pcm.sampleRate, channels: pcm.channels.length };
  } catch {
    /* not WAV/AIFF: let the browser try */
  }
  try {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    return { durationSec: buffer.duration, channels: buffer.numberOfChannels };
  } catch {
    return null;
  }
}

/**
 * Stores an audio file in the sample store and returns its SampleRef (not yet part of the project).
 * Undecodable files are reported with a toast and give null.
 */
export async function importAudioFile(
  s: Services,
  file: Pick<File, 'name' | 'arrayBuffer'>,
): Promise<SampleRef | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const facts = await probeAudio(bytes);
  if (!facts) {
    s.session.getState().toast(`Can't read "${file.name}": not a supported audio file.`, 'error');
    return null;
  }
  const ref = await importSampleBytes(bytes, file.name);
  return { ...ref, ...facts };
}

/** The browser's file chooser for one audio file (null when cancelled). */
export function pickAudioFile(): Promise<File | null> {
  return uploadFile(['audio/*', ...AUDIO_EXTENSIONS.map((e) => `.${e}`)].join(','));
}

/**
 * Puts a sample into one of a plugin's sample slots, or empties the slot with null (one undo step):
 * Drum Pads' pads, a slicer's sample, any plugin that declares `sampleSlots`.
 */
export function setPluginSlotSample(s: Services, owner: PluginOwner, slot: string, ref: SampleRef | null): void {
  s.history.transact(ref ? `Load ${ref.name}` : 'Remove sample', (d) => {
    if (ref) addSample(d, ref);
    setPluginSample(d, owner, slot, ref ? ref.id : null);
  });
}

/** Adds sampler channels for samples (one undo step), after the selected channel. */
export function addSampleChannels(s: Services, refs: readonly SampleRef[], index?: number): ChannelId[] {
  const sampler = s.plugins.get(SAMPLER_ID);
  if (!sampler || refs.length === 0) return [];
  const project = s.doc.getState().project;
  const sel = s.session.getState().selectedChannelId;
  const at = index ?? (sel ? project.channelOrder.indexOf(sel) + 1 : project.channelOrder.length);
  const channels = refs.map((ref, i) =>
    instrumentChannelFor(sampler, ref.name, project.channelOrder.length + i, { main: ref.id }),
  );
  s.history.transact(refs.length === 1 ? `Add ${refs[0]?.name}` : `Add ${refs.length} samples`, (d) => {
    refs.forEach((ref, i) => {
      addSample(d, ref);
      addChannel(d, channels[i] as (typeof channels)[number], at + i);
    });
  });
  const last = channels[channels.length - 1];
  if (last) s.session.getState().selectChannel(last.id);
  return channels.map((c) => c.id);
}

/**
 * FL behaviour: dropping a sample on a channel swaps the channel's sample (and takes its name). Sampler
 * channels change their main sample; audio clip channels change what their clips play.
 */
export function setChannelSample(s: Services, channelId: ChannelId, ref: SampleRef): boolean {
  const ch = s.doc.getState().project.channels[channelId];
  if (!ch || ch.kind === 'automation') return false;
  if (ch.kind === 'instrument' && ch.plugin.pluginId !== SAMPLER_ID) return false;
  s.history.transact(`Load ${ref.name}`, (d) => {
    addSample(d, ref);
    const c = d.channels[channelId];
    if (!c) return;
    if (c.kind === 'audioClip') c.sampleId = ref.id;
    else setPluginSample(d, { kind: 'channel', channelId }, 'main', ref.id);
    c.name = ref.name.slice(0, 64);
  });
  return true;
}

/**
 * FL behaviour: dropping a sample on the playlist creates an "audio clip" channel for it plus a
 * clip as long as the sample (at the current tempo).
 */
export function addAudioClip(s: Services, ref: SampleRef, laneId: LaneId, start: Tick): void {
  const project = s.doc.getState().project;
  const seconds = ref.durationSec ?? (ref.source.kind === 'builtin' ? kitDuration(ref.source.generator) : 1);
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: ref.name,
    color: paletteColor(project.channelOrder.length),
    muted: false,
    solo: false,
    volume: DEFAULT_CHANNEL_VOLUME,
    pan: 0,
    output: project.mixer.order[0] ?? ('master' as AudioClipChannel['output']),
    sampleId: ref.id,
  };
  // The clip lasts as long as the sample at the tempo where it lands.
  const tempo = tempoMapOf(project, 'song');
  const ticks = Math.max(1, Math.round(tempo.secondsToTick(tempo.tickToSeconds(start) + seconds) - start));
  const clip: AudioClip = {
    kind: 'audio',
    id: newId.clip(),
    laneId,
    start,
    length: ticks,
    channelId: channel.id,
    offsetSec: 0,
  };
  s.history.transact(`Add ${channel.name} clip`, (d) => {
    addSample(d, { ...ref, durationSec: seconds });
    addChannel(d, channel);
    addClips(d, [clip]);
  });
  s.editor.getState().selectClips([clip.id]);
}

/** A kit sound dropped on the playlist. */
export function addKitAudioClip(s: Services, generator: string, laneId: LaneId, start: Tick): void {
  const ref = kitSampleRef(generator);
  ref.name = kitPiece(generator)?.name ?? generator;
  addAudioClip(s, { ...ref, durationSec: kitDuration(generator) }, laneId, start);
}
