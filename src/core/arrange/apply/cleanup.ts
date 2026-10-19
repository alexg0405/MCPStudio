import type { Draft } from 'immer';
import { parseFxName } from '../../model/fx';
import type { ChannelId, Clip, PatternId, Project } from '../../model/types';
import { removeChannel } from '../../ops/channels';
import type { ArrangementPlan } from '../plan';
import { ARRANGER_AUTOMATION } from './automation';
import { CRASH_CHANNEL_NAME } from './sounds';
import type { ApplyReport } from './types';
import { isUnmodified } from './variants';

/** What the arranger made that a range's clips use (removed later if nothing else uses them). */
export function arrangerThings(
  p: Project,
  clips: readonly Clip[],
): { patterns: Set<PatternId>; channels: Set<ChannelId> } {
  const patterns = new Set<PatternId>();
  const channels = new Set<ChannelId>();
  for (const c of clips) {
    if (c.kind === 'pattern') {
      if (p.patterns[c.patternId]?.derived) patterns.add(c.patternId);
      continue;
    }
    const ch = p.channels[c.channelId];
    if (!ch) continue;
    if (ch.kind === 'automation' && ARRANGER_AUTOMATION.test(ch.name)) channels.add(ch.id);
    if (ch.kind === 'audioClip') {
      const src = p.samples[ch.sampleId]?.source;
      const isArrangerSound = src?.kind === 'builtin' && parseFxName(src.generator);
      if (isArrangerSound || ch.name === CRASH_CHANNEL_NAME) channels.add(ch.id);
    }
  }
  return { patterns, channels };
}

/**
 * Removes the arranger's things nothing uses any more: variants with no clips (unless edited by
 * hand), FX and crash channels and arranger automation with no clips (and their unused samples).
 */
export function collectGarbage(
  d: Draft<Project>,
  candidates: { patterns: Iterable<PatternId>; channels: Iterable<ChannelId> },
): { patterns: number; channels: number } {
  const p = d as unknown as Project;
  const used = new Set<string>();
  for (const c of Object.values(p.playlist.clips)) used.add(c.kind === 'pattern' ? c.patternId : c.channelId);
  let patterns = 0;
  let channels = 0;
  for (const pid of candidates.patterns) {
    const pat = p.patterns[pid];
    if (!pat?.derived || used.has(pid) || !isUnmodified(pat) || d.patternOrder.length <= 1) continue;
    delete d.patterns[pid];
    d.patternOrder.splice(d.patternOrder.indexOf(pid), 1);
    patterns++;
  }
  for (const cid of candidates.channels) {
    const ch = p.channels[cid];
    if (!ch || used.has(cid)) continue;
    const sample = ch.kind === 'audioClip' ? ch.sampleId : null;
    removeChannel(d, cid);
    channels++;
    const sampleStillUsed = Object.values(p.channels).some((x) => x.kind === 'audioClip' && x.sampleId === sample);
    if (sample && !sampleStillUsed) delete d.samples[sample];
  }
  return { patterns, channels };
}

/** Removes loop-start crash hits from source patterns (the plan's crashes play them where they belong). */
export function moveLoopCrashes(
  d: Draft<Project>,
  plan: Pick<ArrangementPlan, 'loopCrashes'>,
): ApplyReport['movedCrashes'] {
  const out: ApplyReport['movedCrashes'] = [];
  for (const m of plan.loopCrashes) {
    const byId = d.patterns[m.patternId]?.notes[m.channelId];
    if (!byId) continue;
    let count = 0;
    for (const [nid, n] of Object.entries(byId)) {
      if (!m.ticks.includes(n.tick)) continue;
      delete byId[nid as keyof typeof byId];
      count++;
    }
    if (!Object.keys(byId).length) delete d.patterns[m.patternId]!.notes[m.channelId];
    if (!count) continue;
    const prev = out.find((x) => x.patternId === m.patternId);
    if (prev) prev.count += count;
    else out.push({ patternId: m.patternId, count });
  }
  return out;
}
