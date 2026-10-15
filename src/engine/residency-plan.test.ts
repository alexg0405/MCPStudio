import { describe, expect, it } from 'vitest';
import { planResidency, windowSpans, type ClipSpan, type ResidencyInput } from './residency-plan';

const MB = 1024 * 1024;
/** Eight 5-minute songs back to back (each one key of 115 MB), overlapping by 20 s. */
const songs: ClipSpan[] = Array.from({ length: 8 }, (_, i) => ({
  start: i * 280,
  end: i * 280 + 300,
  keys: [`song${i}`],
}));

const input = (over: Partial<ResidencyInput>): ResidencyInput => ({
  clips: songs,
  always: [],
  pos: 0,
  loop: null,
  behind: 2,
  ahead: 30,
  bytesOf: () => 115 * MB,
  budget: 1300 * MB,
  ...over,
});

describe('planResidency', () => {
  it('pins the clips around the playhead and prefetches the next ones in playback order within the budget', () => {
    const p = planResidency(input({ pos: 10 }));
    expect(p.pinned).toEqual(['song0']);
    // 1300 MB: the pinned one plus ten more would fit; seven are left, in order.
    expect(p.prefetch).toEqual(['song1', 'song2', 'song3', 'song4', 'song5', 'song6', 'song7']);
    const tight = planResidency(input({ pos: 10, budget: 350 * MB }));
    expect(tight.prefetch).toEqual(['song1', 'song2']);
  });

  it('pins both songs of a transition and the one about to start', () => {
    const p = planResidency(input({ pos: 285, budget: 400 * MB }));
    expect(p.pinned.sort()).toEqual(['song0', 'song1']);
    expect(p.prefetch).toEqual(['song2']);
    // 20 s before the next song starts, it is pinned already (30 s ahead).
    expect(planResidency(input({ pos: 540, budget: 0 })).pinned.sort()).toEqual(['song1', 'song2']);
  });

  it('pins what playback reaches after wrapping around the loop end', () => {
    const loop = { start: 0, end: 600 };
    expect(windowSpans(590, 2, 30, loop)).toEqual([
      [588, 600],
      [0, 20],
    ]);
    const p = planResidency(input({ pos: 590, loop, budget: 0 }));
    expect(p.pinned.sort()).toEqual(['song0', 'song2']);
  });

  it('keeps "always" keys pinned, shares keys between clips and prefers what comes next to what is behind', () => {
    const clips: ClipSpan[] = [
      { start: 0, end: 10, keys: ['a'] },
      { start: 100, end: 110, keys: ['b'] },
      { start: 200, end: 210, keys: ['a', 'c'] },
    ];
    const p = planResidency(input({ clips, always: ['kick'], pos: 150, budget: 3 * 115 * MB }));
    expect(p.pinned).toEqual(['kick']);
    // The clip at 200 (a and c) comes before b, which is behind the playhead.
    expect(p.prefetch).toEqual(['a', 'c']);
  });
});
