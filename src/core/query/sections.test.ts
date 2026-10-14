import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject } from '../model/defaults';
import { buildStackedSong } from '../fixtures/stacked-song';
import { sectionAt, sectionMatching, songSections } from './sections';

const BAR = 3840;

describe('song sections', () => {
  const p = produce(createEmptyProject(), (d) => void buildStackedSong(d));

  it('runs from each marker to the next, the last to the song end', () => {
    const s = songSections(p);
    expect(s.map((x) => [x.name, x.from / BAR + 1, x.to / BAR])).toEqual([
      ['Intro', 1, 8],
      ['Pre-verse', 9, 16],
      ['Verse', 17, 32],
      ['Build', 33, 36],
      ['Drop', 37, 52],
      ['Bridge', 53, 64],
      ['Build 2', 65, 68],
      ['Drop 2', 69, 84],
      ['Breather', 85, 88],
      ['Final Drop', 89, 100],
      ['Outro', 101, 112],
    ]);
    expect(sectionAt(p, 20 * BAR)?.name).toBe('Verse');
    expect(sectionMatching(p, 16 * BAR, 32 * BAR)?.name).toBe('Verse');
    expect(sectionMatching(p, 16 * BAR, 31 * BAR)).toBeNull();
  });

  it('skips a second marker at the same position and covers a lone marker with a bar', () => {
    const q = produce(createEmptyProject(), (d) => {
      d.playlist.markers['mk_a' as never] = { id: 'mk_a' as never, tick: 0, name: 'A' };
      d.playlist.markers['mk_b' as never] = { id: 'mk_b' as never, tick: 0, name: 'B' };
    });
    expect(songSections(q)).toEqual([{ markerId: 'mk_a', name: 'A', from: 0, to: BAR }]);
  });
});
