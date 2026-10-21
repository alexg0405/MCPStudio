import { playbackKey } from '@core/audio/playback';
import { automationModelOf } from '@core/automation/model';
import type { ChannelId, MidiFxSlot, Project } from '@core/model/types';

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

/** The MIDI effect chains of the instrument channels (undefined for a channel with none), one entry per channel in rack order. */
type EffectChains = readonly (readonly MidiFxSlot[] | undefined)[];

const NO_CHAINS: EffectChains = [];

/** Memoized per channels record. An edit makes a new list for the chain it changes only, so chains compare by identity. */
const chainLists = new WeakMap<Project['channels'], EffectChains>();

function effectChainsOf(project: Project): EffectChains {
  let chains = chainLists.get(project.channels);
  if (chains === undefined) {
    const found: (readonly MidiFxSlot[] | undefined)[] = [];
    for (const id of project.channelOrder) {
      const channel = project.channels[id];
      if (channel?.kind === 'instrument') found.push(channel.midiFx);
    }
    chains = found.some((chain) => chain !== undefined) ? found : NO_CHAINS;
    chainLists.set(project.channels, chains);
  }
  return chains;
}

/** The automation clips that drive MIDI effect knobs, as the objects the evaluation reads (the same ones while they do not change). */
function effectAutomationOf(project: Project): readonly unknown[] {
  const found: unknown[] = [];
  for (const [key, automation] of automationModelOf(project).targets) if (key.startsWith('mfx:')) found.push(automation);
  return found;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, i) => item === b[i]);

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
  /** The MIDI effect chains and the automation of their knobs, as of the last version. */
  private chains: EffectChains = NO_CHAINS;
  private chainAutomation: readonly unknown[] = [];

  /** Reads the new project and reports whether the plan must be made again. Call it once per project version. */
  update(prev: Project | null, next: Project, muted: ReadonlySet<ChannelId>): boolean {
    const muteKey = muteKeyOf(muted);
    const channelsChanged = !prev || prev.channels !== next.channels;
    const audioKey = channelsChanged ? audioKeyOf(next) : this.audioKey;
    const chains = channelsChanged ? effectChainsOf(next) : this.chains;
    const hasEffects = chains.length > 0;
    // A chord track, a playlist (it holds the automation clips) or channels that changed matter to a note only when a chain looks at them.
    const chainAutomation = hasEffects ? effectAutomationOf(next) : [];
    const effectsChanged =
      !sameList(chains, this.chains) ||
      !sameList(chainAutomation, this.chainAutomation) ||
      (hasEffects && !!prev && prev.chords !== next.chords);
    this.chains = chains;
    this.chainAutomation = chainAutomation;
    const changed =
      !prev ||
      effectsChanged ||
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
