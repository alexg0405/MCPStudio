/**
 * "Clean up the song": removes parts stacked on themselves (the same clips playing twice or three
 * times at once), merges automation channels that are the same curve on the same control, and names
 * tracks that still say "Track N" after the one thing they play.
 */
import type { Draft } from 'immer';
import type { AutomationChannel, ChannelId, LaneId, Project, Tick } from '../model/types';
import { automationKey, stackedCopies } from '../query/arrangement';
import { removeChannel } from './channels';

export interface TidyReport {
  /** Stacked copies removed. */
  stacked: number;
  /** Automation channels merged into another. */
  automation: number;
  /** Tracks named. */
  named: { laneId: LaneId; name: string }[];
}

const DEFAULT_LANE_NAME = /^Track \d+$/;

export function tidySong(
  d: Draft<Project>,
  opts: { stacked?: boolean; automation?: boolean; names?: boolean; range?: { from: Tick; to: Tick } } = {},
): TidyReport {
  const p = d as unknown as Project;
  const report: TidyReport = { stacked: 0, automation: 0, named: [] };
  if (opts.stacked !== false) {
    for (const copy of stackedCopies(p)) {
      if (opts.range && (copy.to <= opts.range.from || copy.from >= opts.range.to)) continue;
      delete d.playlist.clips[copy.clipId];
      report.stacked++;
    }
  }
  if (opts.automation !== false) {
    const keep = new Map<string, ChannelId>();
    for (const id of [...d.channelOrder]) {
      const ch = d.channels[id];
      if (ch?.kind !== 'automation') continue;
      const key = automationKey(ch as unknown as AutomationChannel);
      const first = keep.get(key);
      if (!first) {
        keep.set(key, id);
        continue;
      }
      for (const clip of Object.values(d.playlist.clips))
        if (clip.kind === 'automation' && clip.channelId === id) clip.channelId = first;
      removeChannel(d, id);
      report.automation++;
    }
  }
  if (opts.names !== false) {
    for (const laneId of d.playlist.laneOrder) {
      const lane = d.playlist.lanes[laneId];
      if (!lane || !DEFAULT_LANE_NAME.test(lane.name)) continue;
      const clips = Object.values(d.playlist.clips).filter((c) => c.laneId === laneId);
      if (!clips.length) continue;
      // Named after its one pattern (automation clips beside it don't count), or its one channel.
      const patterns = new Set(clips.flatMap((c) => (c.kind === 'pattern' ? [c.patternId] : [])));
      const others = new Set(clips.flatMap((c) => (c.kind === 'pattern' ? [] : [c.channelId])));
      let name: string | undefined;
      if (patterns.size === 1) name = d.patterns[[...patterns][0]!]?.name;
      else if (patterns.size === 0 && others.size === 1) name = d.channels[[...others][0]!]?.name;
      if (!name) continue;
      lane.name = name.slice(0, 64);
      report.named.push({ laneId, name: lane.name });
    }
  }
  return report;
}
