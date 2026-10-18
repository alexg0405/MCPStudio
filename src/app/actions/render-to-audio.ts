/**
 * Renders that become audio clips again: "Consolidate" (the selected clips, or the loop region,
 * into one new audio clip) and "Freeze channel" (a channel's whole part in the song as an audio
 * clip, the original muted; Unfreeze restores it). Rendered offline with the same engine as
 * playback, without the master chain and the safety limiter (the new clip plays through them),
 * stored as 24-bit FLAC in the sample store (turned down when louder than full scale, with the clip
 * gain turning it back up).
 */
import { tempoMapOf } from '@core/automation/tempo';
import { MAX_CLIP_GAIN } from '@core/audio/envelope';
import { naturalLength, playbackMode } from '@core/audio/playback';
import { makeLane, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type ChannelId,
  type Clip,
  type ClipId,
  type LaneId,
  type Project,
  type Tick,
} from '@core/model/types';
import { addChannel, addSample, removeChannel } from '@core/ops/channels';
import { addClips, addLane, removeClips } from '@core/ops/playlist';
import { freeLaneRun } from '@core/query/lanes';
import { clipsSorted } from '@core/query/playlist';
import { withoutMasterChain } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { produce } from 'immer';
import { encodeOffThread } from '../export/encode';
import { trimExport } from '../export/export-wav';
import { importSampleBytes } from '../persistence/sample-import';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';

export class RenderToAudioError extends Error {}

export interface Rendered {
  ref: Awaited<ReturnType<typeof importSampleBytes>> & { durationSec: number; sampleRate: number; channels: number };
  seconds: number;
  /**
   * Clip gain that restores the render's level: a render louder than full scale (it has no master
   * chain or limiter) is stored turned down, since audio files and decoders clip at full scale.
   */
  gain: number;
}

/**
 * Renders [from, to) of a project variant (song mode) into a stored FLAC sample, with the tails
 * that ring past `to`.
 */
export function renderRange(
  s: Services,
  project: Project,
  from: Tick,
  to: Tick,
  name: string,
  signal?: AbortSignal,
): Promise<Rendered> {
  // The audio the render reads stays stored until it is done (clean-up of unused audio waits).
  return whileBusy(() => renderRangeOf(s, project, from, to, name, signal), { project });
}

async function renderRangeOf(
  s: Services,
  project: Project,
  from: Tick,
  to: Tick,
  name: string,
  signal?: AbortSignal,
): Promise<Rendered> {
  const bar = ticksPerBar(project.transport.timeSig);
  const tempo = tempoMapOf(project, 'song');
  const musical = tempo.tickToSeconds(to) - tempo.tickToSeconds(from);
  s.engine.stop();
  const result = await renderOffline(withoutMasterChain(project), {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: 'song', patternId: null, loop: null },
    bars: (to - from) / bar,
    fromTick: from,
    sampleRate: s.engine.sampleRate,
    tail: 'auto',
    limiter: false,
    ...(signal ? { signal } : {}),
  });
  const channels = trimExport(result, musical);
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) throw new RenderToAudioError('The render came out empty.');
  const sampleRate = result.buffer.sampleRate;
  // Over full scale (it has no master chain or limiter): stored turned down, the clip gain (up to
  // +12 dB) turns it back up. Decoders clip at full scale, even for float WAV.
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i] as number));
  const gain = Math.min(MAX_CLIP_GAIN, Math.max(1, peak));
  if (gain > 1) for (const c of channels) for (let i = 0; i < c.length; i++) c[i] = (c[i] as number) / gain;
  const bytes = await encodeOffThread(channels, sampleRate, { codec: 'flac', bits: 24, kbps: 0 });
  const ref = await importSampleBytes(bytes, `${name}.flac`);
  return {
    ref: { ...ref, durationSec: frames / sampleRate, sampleRate, channels: channels.length },
    seconds: frames / sampleRate,
    gain,
  };
}

export function audioChannel(name: string, color: string, sampleId: AudioClipChannel['sampleId'], output = MASTER): AudioClipChannel {
  return {
    kind: 'audioClip',
    id: newId.channel(),
    name: name.slice(0, 64),
    color,
    muted: false,
    solo: false,
    // The render already has the channels' volumes and pans in it.
    volume: 1,
    pan: 0,
    output,
    sampleId,
  };
}

/** The clips "Consolidate" uses: the selected ones, or every clip in the loop region. */
export function consolidationSet(s: Services): Clip[] {
  const p = s.doc.getState().project;
  const sel = s.editor.getState().clipSelection.map((id) => p.playlist.clips[id]).filter((c): c is Clip => !!c);
  const playable = (c: Clip) => !c.muted && c.kind !== 'automation';
  if (sel.length) return sel.filter(playable);
  const loop = s.view.getState().loop;
  if (!loop) return [];
  return clipsSorted(p.playlist.clips).filter((c) => playable(c) && c.start < loop.end && c.start + c.length > loop.start);
}

/**
 * Renders clips (the selection, or the loop region) into one new audio clip that replaces them, on
 * the top-most of their tracks. Automation and tempo keep playing in the render, so it sounds the
 * same. Rejects with RenderToAudioError when there is nothing to render.
 */
export async function consolidate(
  s: Services,
  clips: readonly Clip[] = consolidationSet(s),
  /** The merged clip may go on a comp or take track (Flatten and merge does: it releases them right after). */
  opts: { onTakeTrack?: boolean } = {},
): Promise<ClipId> {
  const p = s.doc.getState().project;
  const list = clips.filter((c) => !c.muted && c.kind !== 'automation');
  if (list.length === 0) throw new RenderToAudioError('Select the clips to consolidate (or set a loop region) first.');
  const loop = s.editor.getState().clipSelection.length ? null : s.view.getState().loop;
  const from = loop ? loop.start : Math.min(...list.map((c) => c.start));
  const to = loop ? loop.end : Math.max(...list.map((c) => c.start + c.length));
  const keep = new Set(list.map((c) => c.id));
  // Only these clips play; automation clips stay so the render sounds like the song.
  const solo = produce(p, (d) => {
    for (const c of Object.values(d.playlist.clips))
      if (c.kind !== 'automation' && !keep.has(c.id)) delete d.playlist.clips[c.id];
  });
  const name = list.length === 1 ? `${clipName(p, list[0]!)} (consolidated)` : 'Consolidated';
  const { ref, gain } = await renderRange(s, solo, from, to, name);
  const lanes = p.playlist.laneOrder;
  // The top-most of their tracks; a recording's comp and take tracks hold only that recording (addClips finds
  // another track when the clips were all there).
  const laneId = lanes.find((id) => list.some((c) => c.laneId === id) && (opts.onTakeTrack || !p.playlist.lanes[id]?.takes)) ?? (lanes[0] as LaneId);
  const ch = audioChannel(name, paletteColor(p.channelOrder.length), ref.id);
  const tempo = tempoMapOf(p, 'song');
  const clip: AudioClip = {
    kind: 'audio',
    id: newId.clip(),
    laneId,
    start: from,
    length: naturalLength({ start: from, offsetSec: 0 }, playbackMode(ch), tempo, ref.durationSec),
    channelId: ch.id,
    offsetSec: 0,
    ...(gain > 1 ? { gain } : {}),
  };
  s.history.transact(list.length > 1 ? `Consolidate ${list.length} clips` : 'Consolidate clip', (d) => {
    addSample(d, ref);
    addChannel(d, ch);
    removeClips(d, [...keep]);
    addClips(d, [clip], { toTakeLanes: !!opts.onTakeTrack });
  });
  s.editor.getState().selectClips([clip.id]);
  return clip.id;
}

function clipName(p: Project, c: Clip): string {
  if (c.name) return c.name;
  if (c.kind === 'pattern') return p.patterns[c.patternId]?.name ?? 'Pattern';
  return p.channels[c.channelId]?.name ?? 'Audio';
}

/** Where a channel plays in the song: from the bar its first clip starts in to its last clip's end. */
export function channelSpan(p: Project, channelId: ChannelId): { from: Tick; to: Tick } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const c of Object.values(p.playlist.clips)) {
    if (c.muted) continue;
    const plays =
      (c.kind === 'audio' && c.channelId === channelId) ||
      (c.kind === 'pattern' && Object.values(p.patterns[c.patternId]?.notes[channelId] ?? {}).some((n) => !n.muted));
    if (!plays) continue;
    from = Math.min(from, c.start);
    to = Math.max(to, c.start + c.length);
  }
  if (!Number.isFinite(from)) return null;
  const bar = ticksPerBar(p.transport.timeSig);
  return { from: Math.floor(from / bar) * bar, to };
}

/**
 * Freeze: renders what a channel plays in the song (its sound before its mixer track: instrument,
 * volume and pan) into an audio clip channel on the same mixer track, and mutes the original.
 */
export async function freezeChannel(s: Services, channelId: ChannelId): Promise<ChannelId> {
  const p = s.doc.getState().project;
  const ch = p.channels[channelId];
  if (!ch || ch.kind === 'automation') throw new RenderToAudioError('Only instrument and audio channels can be frozen.');
  if (ch.kind === 'audioClip' && ch.frozenFrom) throw new RenderToAudioError(`“${ch.name}” is already a frozen channel.`);
  const span = channelSpan(p, channelId);
  if (!span) throw new RenderToAudioError(`“${ch.name}” doesn't play anywhere in the song: put it on the playlist first.`);
  // Only this channel, straight into the master, so the render is its sound before its mixer track.
  const alone = produce(p, (d) => {
    for (const c of Object.values(d.channels)) if (c.kind !== 'automation') c.muted = c.id !== channelId;
    for (const c of Object.values(d.channels)) if (c.kind !== 'automation') c.solo = false;
    const me = d.channels[channelId];
    if (me && me.kind !== 'automation') me.output = MASTER;
    const master = d.mixer.inserts[MASTER];
    if (master) master.muted = false;
  });
  const { ref, gain } = await renderRange(s, alone, span.from, span.to, `${ch.name} (frozen)`);
  const frozen: AudioClipChannel = { ...audioChannel(`${ch.name} (frozen)`, ch.color, ref.id, ch.output), frozenFrom: channelId };
  const tempo = tempoMapOf(p, 'song');
  const length = naturalLength({ start: span.from, offsetSec: 0 }, playbackMode(frozen), tempo, ref.durationSec);
  const laneIndex = freeLaneRun(p, span.from, span.from + length, 1);
  const lane = laneIndex < p.playlist.laneOrder.length ? (p.playlist.laneOrder[laneIndex] as LaneId) : null;
  const newLane = lane ? null : makeLane(`Track ${p.playlist.laneOrder.length + 1}`);
  const clip: AudioClip = {
    kind: 'audio',
    id: newId.clip(),
    laneId: lane ?? (newLane!.id as LaneId),
    start: span.from,
    length,
    channelId: frozen.id,
    offsetSec: 0,
    ...(gain > 1 ? { gain } : {}),
  };
  s.history.transact(`Freeze ${ch.name}`, (d) => {
    addSample(d, ref);
    addChannel(d, frozen, d.channelOrder.indexOf(channelId) + 1);
    if (newLane) addLane(d, newLane);
    addClips(d, [clip]);
    const orig = d.channels[channelId];
    if (orig) orig.muted = true;
  });
  return frozen.id;
}

/** The frozen copy of a channel, if it has one (or the channel itself when it is a frozen copy). */
export function frozenCopyOf(p: Project, channelId: ChannelId): AudioClipChannel | null {
  const ch = p.channels[channelId];
  if (ch?.kind === 'audioClip' && ch.frozenFrom) return ch;
  for (const c of Object.values(p.channels)) if (c.kind === 'audioClip' && c.frozenFrom === channelId) return c;
  return null;
}

/** Unfreeze: deletes the frozen copy (and its clips) and unmutes the original. */
export function unfreezeChannel(s: Services, channelId: ChannelId): boolean {
  const p = s.doc.getState().project;
  const frozen = frozenCopyOf(p, channelId);
  if (!frozen?.frozenFrom) return false;
  const original = p.channels[frozen.frozenFrom];
  s.history.transact(`Unfreeze ${original?.name ?? frozen.name}`, (d) => {
    const from = frozen.frozenFrom as ChannelId;
    removeChannel(d, frozen.id);
    const orig = d.channels[from];
    if (orig) orig.muted = false;
  });
  return true;
}
