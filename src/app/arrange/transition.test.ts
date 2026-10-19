import { describe, expect, it } from 'vitest';
import { BAR, addKit, notes, trapGroove } from '../../../test/helpers/arrange';
import { createTestServices } from '../testing';
import { TRANSITION_KINDS, transitionInDraft, type TransitionInput } from './run';

/** Four 2-bar clips of one trap beat, back to back: 8 bars, no markers. */
function beatSong() {
  const s = createTestServices();
  s.history.transact('beat', (d) => {
    const k = addKit(d);
    const pid = d.patternOrder[0]!;
    const pat = d.patterns[pid]!;
    pat.name = 'Beat';
    pat.length = 2 * BAR;
    pat.stepCount = 32;
    pat.notes = trapGroove(k) as never;
    const lane = d.playlist.laneOrder[0]!;
    for (let b = 0; b < 8; b += 2)
      d.playlist.clips[`c${b}` as never] = { kind: 'pattern', id: `c${b}`, laneId: lane, start: b * BAR, length: 2 * BAR, patternId: pid, offset: 0 } as never;
    d.patterns[pid]!.notes[k.pad] = notes([[0, 60, 32]]) as never;
  });
  return s;
}

/** Runs one transition on a fresh copy of the song and says what it reported (each is one undo step in the app). */
function run(input: TransitionInput) {
  const s = beatSong();
  const base = s.doc.getState().project;
  const guarded: string[] = [];
  let result!: ReturnType<typeof transitionInDraft>;
  s.history.transact('transition', (d) => {
    result = transitionInDraft(d, s, base, input, (from, to, what) => guarded.push(`${what} ${from}-${to}`));
  });
  return { result, guarded };
}

describe('transitionInDraft', () => {
  it('reports each kind of transition at bar 5 in its own words', () => {
    const lines = TRANSITION_KINDS.map((kind) => {
      const { result, guarded } = run({ at: 4 * BAR, kind });
      return `${kind}: ${result.changes[0]} | clips ${result.clipIds.length} | span ${result.touched?.from}-${result.touched?.to} | guard ${guarded.join(',')}`;
    });
    expect(lines).toMatchInlineSnapshot(`
      [
        "auto: Added a same into “Part 1” at bar 5 | clips 1 | span 13440-15360 | guard transition 13440-15360",
        "rise: Added a rise into “Part 1” at bar 5 | clips 6 | span 0-15360 | guard transition 0-15360",
        "lift: Added a lift into “Part 1” at bar 5 | clips 3 | span 0-15360 | guard transition 0-15360",
        "same: Added a same into “Part 1” at bar 5 | clips 1 | span 13440-15360 | guard transition 13440-15360",
        "dip: Added a dip into “Part 1” at bar 5 | clips 2 | span 14400-15360 | guard transition 14400-15360",
        "fall: Added a fall into “Part 1” at bar 5 | clips 5 | span 14400-23040 | guard transition 14400-23040",
        "fill: Added fill at bar 5 | clips 1 | span 13440-15360 | guard transition 13440-15360",
        "gap: Added gap at bar 5 | clips 1 | span 14400-15360 | guard transition 14400-15360",
        "riser: Added riser at bar 5 | clips 1 | span 0-15360 | guard transition 0-15360",
        "reverse_crash: Added reverse crash at bar 5 | clips 1 | span 11520-15360 | guard transition 11520-15360",
        "impact: Added impact at bar 5 | clips 1 | span 15360-15360 | guard transition 15360-15360",
        "downlifter: Added downlifter at bar 5 | clips 1 | span 15360-15360 | guard transition 15360-15360",
        "crash: Crash at bar 5: already there (nothing added) | clips 0 | span 15360-15360 | guard transition 15360-15360",
        "filter_open: Added filter open at bar 5 | clips 2 | span 15360-30720 | guard transition 15360-30720",
        "filter_close: Added filter close at bar 5 | clips 2 | span 7680-15360 | guard transition 7680-15360",
        "reverb_throw: Reverb throw at bar 5: already there (nothing added) | clips 0 | span 14400-15360 | guard transition 14400-15360",
      ]
    `);
  });

  it('says there is no section to lead into when a recipe is asked for outside the song', () => {
    const { result, guarded } = run({ at: 100 * BAR, kind: 'rise' });
    expect(result.warnings).toEqual(['there is no section at bar 101 to lead into']);
    expect(result.touched).toBeNull();
    expect(guarded).toEqual([]);
  });

  it('keeps lengths in range: beats between 1 and 16, bars between 1 and 8', () => {
    const long = run({ at: 4 * BAR, kind: 'riser', bars: 40 }).result.touched!;
    const short = run({ at: 4 * BAR, kind: 'riser', bars: 0 }).result.touched!;
    expect(long.from).toBeLessThan(short.from);
    expect(4 * BAR - long.from).toBeLessThanOrEqual(8 * BAR);
    const gap = run({ at: 4 * BAR, kind: 'gap', beats: 99 }).result.touched!;
    expect(4 * BAR - gap.from).toBe(16 * 960);
  });
});
