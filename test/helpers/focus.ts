/**
 * Test helpers for "Ask AI about this part": the stacked 113-bar song in test services, and quick
 * reads of what plays where.
 */
import { createTestServices } from '@app/testing';
import { buildStackedSong, type StackedSong } from '@core/fixtures/stacked-song';
import type { Clip, PatternClip, PatternId, Project } from '@core/model/types';

export const BAR = 3840;

export type TestServices = ReturnType<typeof createTestServices>;

/** Test services holding the stacked song (as an opened project: no undo history). */
export function stackedSong(): { s: TestServices; ids: StackedSong } {
  const s = createTestServices();
  let ids!: StackedSong;
  s.history.transact('song', (d) => {
    ids = buildStackedSong(d);
  });
  s.history.load(s.doc.getState().project);
  s.view.getState().setCurrentPattern(s.doc.getState().project.patternOrder[0] ?? null);
  return { s, ids };
}

export const project = (s: TestServices): Project => s.doc.getState().project;

export const clipsOf = (p: Project, pid: PatternId): PatternClip[] =>
  (Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId === pid) as PatternClip[]).sort(
    (a, b) => a.start - b.start || (a.id < b.id ? -1 : 1),
  );

/** Every clip as a comparable line ("lane 1 bar 37 ×2 pat_…"), sorted. */
export const clipLines = (p: Project, keep: (c: Clip) => boolean = () => true): string[] =>
  Object.values(p.playlist.clips)
    .filter(keep)
    .map(
      (c) =>
        `lane ${p.playlist.laneOrder.indexOf(c.laneId) + 1} at ${c.start} len ${c.length} off ${c.kind === 'audio' ? c.offsetSec : c.offset} ${
          c.kind === 'pattern' ? c.patternId : c.channelId
        }${c.muted ? ' muted' : ''}`,
    )
    .sort();
