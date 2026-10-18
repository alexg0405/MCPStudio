import { playbackKey } from '@core/audio/playback';
import type { ChannelId, Project } from '@core/model/types';

/** Memoized per channels record: the same record always gives the same key. */
const audioKeys = new WeakMap<Project['channels'], string>();

/**
 * One string for how every audio clip channel plays (see playbackKey), so a change in any of them is one string
 * comparison. Memoized per channels record.
 */
function audioKeyOf(project: Project): string {
  let key = audioKeys.get(project.channels);
  if (key === undefined) {
    const parts: string[] = [];
    for (const id of project.channelOrder) {
      const channel = project.channels[id];
      if (channel?.kind === 'audioClip') parts.push(`${id}:${playbackKey(channel)}`);
    }
    key = parts.join(',');
    audioKeys.set(project.channels, key);
  }
  return key;
}

/** The muted channels as one sorted string, so a change in who is muted is one string comparison. */
function muteKeyOf(muted: ReadonlySet<ChannelId>): string {
  return [...muted].sort().join(',');
}

/**
 * Decides whether a new version of the project changes what the transport plays, so the song must be planned again:
 * the patterns, the playlist, the transport settings and the channel order do, and so do who is muted (a muted
 * channel's notes are left out of the plan) and how audio clips play (playing clips restart when they change).
 */
export class SchedulingWatch {
  private muteKey = '';
  /** How every audio clip channel plays its sample. */
  private audioKey = '';

  /** Reads the new project and reports whether the plan must be made again. Call it once per project version. */
  update(prev: Project | null, next: Project, muted: ReadonlySet<ChannelId>): boolean {
    const muteKey = muteKeyOf(muted);
    const channelsChanged = !prev || prev.channels !== next.channels;
    const audioKey = channelsChanged ? audioKeyOf(next) : this.audioKey;
    const changed =
      !prev ||
      prev.patterns !== next.patterns ||
      prev.playlist !== next.playlist ||
      prev.transport !== next.transport ||
      prev.channelOrder !== next.channelOrder ||
      muteKey !== this.muteKey ||
      audioKey !== this.audioKey;
    this.muteKey = muteKey;
    this.audioKey = audioKey;
    return changed;
  }
}

/** Whether the sample residency (which decoded buffers stay in memory) must be told about a new project version. */
export function residencyInputsChanged(prev: Project | null, next: Project): boolean {
  return (
    !prev ||
    prev.playlist !== next.playlist ||
    prev.channels !== next.channels ||
    prev.transport !== next.transport ||
    prev.samples !== next.samples
  );
}
