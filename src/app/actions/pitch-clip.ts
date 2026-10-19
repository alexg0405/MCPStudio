/** Which clip a pitch edit belongs to, and whether it can be edited (shared by the actions and the renderer). */
import type { AudioClip, AudioClipChannel, ClipId, Project } from '@core/model/types';

export class PitchError extends Error {}

/** The audio clip and its channel (null when the id is not an audio clip). */
export function audioClipOf(p: Project, id: ClipId): { clip: AudioClip; channel: AudioClipChannel } | null {
  const clip = p.playlist.clips[id];
  if (clip?.kind !== 'audio') return null;
  const channel = p.channels[clip.channelId];
  return channel?.kind === 'audioClip' ? { clip, channel } : null;
}

/** Why a clip can't be pitch-edited, in plain words (null when it can). */
export function pitchProblem(p: Project, id: ClipId): string | null {
  const found = audioClipOf(p, id);
  if (!found) return 'That is not an audio clip.';
  if (found.channel.reverse) return 'Pitch correction needs the sound played forwards: turn off Reverse on this audio first.';
  if (!p.samples[found.channel.sampleId]) return 'This clip’s audio is missing.';
  return null;
}
