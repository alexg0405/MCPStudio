/**
 * Finding the recorded vocals on the playlist: audio clips of a channel that plays a voice (or a recording nobody named),
 * not the sound effects and not the harmony voices made from another clip.
 */
import type { AudioClip } from '../model/types';
import { rangeTicks, type SongFacts } from './song-facts';
import type { BarRange } from './types';

/** The voice clips that overlap the ranges (all of them when no range is given), in song order. */
export function clipsOverlapping(facts: SongFacts, ranges: readonly BarRange[]): AudioClip[] {
  const spans = ranges.map((range) => rangeTicks(facts, range));
  const found: AudioClip[] = [];
  for (const clip of Object.values(facts.project.playlist.clips)) {
    if (clip.kind !== 'audio' || clip.muted || clip.harmony) continue;
    const role = facts.roles.get(clip.channelId);
    if (role !== 'vox' && role !== 'other') continue;
    if (spans.length > 0 && !spans.some((span) => clip.start < span.to && clip.start + clip.length > span.from)) continue;
    found.push(clip);
  }
  return found.sort((a, b) => a.start - b.start);
}
