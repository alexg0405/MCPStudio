/**
 * Gives one part of the song its own copy of a pattern, so editing the part leaves the rest of the
 * song as it was ("Ask AI about this part"): clips of the pattern that straddle the part's edges are
 * split there, the pattern is cloned, and the clips inside the part play the clone. Every clip
 * outside the part keeps playing the original.
 */
import type { Draft } from 'immer';
import { newId } from '../model/ids';
import type { ClipId, PatternClip, PatternId, Project, Tick } from '../model/types';
import type { TempoMap } from '../time/ppq';
import { clonePattern, splitClip } from './playlist';

export type ForkPart =
  /** A span of the song (exclusive end): straddling clips are split at its edges, the clips inside it (and `also`) move. */
  | { from: Tick; to: Tick; also?: ReadonlySet<ClipId> }
  /** Exactly these clips move to the copy; nothing is split. */
  | { clips: ReadonlySet<ClipId> };

export interface ForkResult {
  /** Clips that play the copy now. */
  moved: ClipId[];
  /** Clips split at the part's edges, as [the clip, the piece split off it]. */
  split: [ClipId, ClipId][];
}

/** The pattern clips of `pid`, by start (plain loop: safe on drafts). */
function clipsOf(d: Draft<Project>, pid: PatternId): PatternClip[] {
  const out: PatternClip[] = [];
  for (const c of Object.values(d.playlist.clips)) if (c.kind === 'pattern' && c.patternId === pid) out.push(c as PatternClip);
  return out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

/**
 * Clones `pid` as `cloneId` (named `name`, placed after the original) for a part of the song and
 * points the part's clips at it. Muted clips count like any other. Returns what moved and what was
 * split; nothing happens when the pattern doesn't exist.
 */
export function forkPattern(
  d: Draft<Project>,
  pid: PatternId,
  part: ForkPart,
  cloneId: PatternId,
  name: string,
  tempo: TempoMap,
): ForkResult {
  const result: ForkResult = { moved: [], split: [] };
  if (!d.patterns[pid]) return result;
  let inside: (c: PatternClip) => boolean;
  if ('clips' in part) {
    inside = (c) => part.clips.has(c.id);
  } else {
    const { from, to } = part;
    // Split at the edges first, so each piece lies wholly inside or outside the part.
    for (const edge of [from, to]) {
      for (const c of clipsOf(d, pid)) {
        // `also` clips move whole (an answer's own transition clip just outside the part).
        if (part.also?.has(c.id)) continue;
        if (c.start < edge && edge < c.start + c.length) {
          const piece = newId.clip();
          splitClip(d, c.id, edge, tempo, piece);
          result.split.push([c.id, piece]);
        }
      }
    }
    inside = (c) => (c.start >= from && c.start + c.length <= to && c.length > 0) || !!part.also?.has(c.id);
  }
  const moving = clipsOf(d, pid).filter(inside);
  if (moving.length === 0) return result;
  clonePattern(d, pid, cloneId, name);
  for (const c of moving) {
    (d.playlist.clips[c.id] as Draft<PatternClip>).patternId = cloneId;
    result.moved.push(c.id);
  }
  return result;
}
