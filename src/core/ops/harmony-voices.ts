import type { Draft } from 'immer';
import type { AudioClip, AudioClipChannel, ChannelId, Lane, LaneId, Project, SampleId, SampleRef } from '../model/types';
import { addChannel, addSample } from './channels';
import { addClips, addLane } from './playlist';

// Draft mutators for harmony voices (made by "Make harmonies…", see core/harmony/voices). The app renders the voices, then
// writes them all in one History transaction through these.

/** One new voice: its track, the sound's channel and sample, and the clip that plays it. */
export interface NewHarmonyVoice {
  lane: Lane;
  channel: AudioClipChannel;
  sample: SampleRef;
  clip: AudioClip;
}

/**
 * Where new tracks under a lead's track go: right below it, or below the whole group when the lead is on a recording's
 * comp or take tracks (those stay together).
 */
function insertionIndexBelow(d: Draft<Project>, laneId: LaneId): number {
  const order = d.playlist.laneOrder;
  const at = order.indexOf(laneId);
  const group = d.playlist.lanes[laneId]?.takes?.group;
  if (at < 0) return order.length;
  let end = at + 1;
  while (group && end < order.length && d.playlist.lanes[order[end] as LaneId]?.takes?.group === group) end++;
  return end;
}

/** Adds the voices as new tracks (in the order given) right under the lead's track, each with its channel, sample and clip. */
export function addHarmonyVoices(d: Draft<Project>, leadLane: LaneId, voices: readonly NewHarmonyVoice[]): void {
  let index = insertionIndexBelow(d, leadLane);
  for (const voice of voices) {
    addLane(d, voice.lane, index++);
    addSample(d, voice.sample);
    addChannel(d, voice.channel);
    addClips(d, [voice.clip]);
  }
}

/** True when something other than `except` still plays `sampleId`. */
function soundInUse(d: Draft<Project>, sampleId: SampleId, except: ChannelId): boolean {
  for (const ch of Object.values(d.channels)) {
    if (ch.kind === 'audioClip' && ch.id !== except && ch.sampleId === sampleId) return true;
  }
  for (const c of Object.values(d.playlist.clips)) if (c.kind === 'audio' && c.pitchEdit?.renderedSampleId === sampleId) return true;
  return false;
}

/**
 * Gives a voice its new render: the channel plays the new sample, the old one leaves the project's samples when nothing else
 * plays it (its audio is cleaned up with other unused audio), and the voice's clips remember what the render was made from.
 */
export function setHarmonyRender(d: Draft<Project>, channelId: ChannelId, sample: SampleRef, signature: string): void {
  const channel = d.channels[channelId];
  if (channel?.kind !== 'audioClip') return;
  const old = channel.sampleId;
  addSample(d, sample);
  channel.sampleId = sample.id;
  if (old !== sample.id && d.samples[old] && !soundInUse(d, old, channelId)) delete d.samples[old];
  for (const clip of Object.values(d.playlist.clips)) {
    if (clip.kind === 'audio' && clip.channelId === channelId && clip.harmony) clip.harmony.renderedFor = signature;
  }
}
