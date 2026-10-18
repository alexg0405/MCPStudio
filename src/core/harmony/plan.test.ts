import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { channelRoles } from '../arrange/roles';
import { placeChords } from '../ops/chords';
import type { Note } from '../model/types';
import { mod12, parseChord } from './chord';
import { findKickPattern, partLength, planBassPart, planChordPart, planMelodyFit } from './plan';
import { makeHarmonySong } from './test-song';
import { totalMovement } from './voicing';

const BAR = 3840;
const song = makeHarmonySong(['C', 'C', 'C', 'C']);
const withChords = (names: string[], barsEach = 1) =>
  produce(song.project, (draft) => {
    placeChords(
      draft,
      names.map((name, index) => ({ tick: index * barsEach * BAR, length: barsEach * BAR, chord: parseChord(name)! })),
    );
  });
const roles = channelRoles(song.project);

describe('planning a chord part', () => {
  it('voices the chord track over the pattern with the chords the track says', () => {
    const project = withChords(['Am', 'F', 'C', 'G']);
    const plan = planChordPart(project, song.patternId)!;
    expect(plan.chordCount).toBe(4);
    expect(plan.length).toBe(4 * BAR);
    const bars = [0, 1, 2, 3].map((bar) => plan.notes.filter((note) => note.tick === bar * BAR).map((note) => note.key));
    expect(bars.map((keys) => [...new Set(keys.map(mod12))].sort((a, b) => a - b))).toEqual([
      [0, 4, 9],
      [0, 5, 9],
      [0, 4, 7],
      [2, 7, 11],
    ]);
    expect(totalMovement(bars)).toBeLessThanOrEqual(10);
  });

  it('follows the register, the rhythm and the bass option', () => {
    const project = withChords(['Am', 'F', 'C', 'G']);
    const low = planChordPart(project, song.patternId, { register: 'low' })!;
    const high = planChordPart(project, song.patternId, { register: 'high' })!;
    expect(Math.max(...low.notes.map((n) => n.key))).toBeLessThan(Math.max(...high.notes.map((n) => n.key)));
    expect(planChordPart(project, song.patternId, { rhythm: 'beats' })!.notes.length).toBe(4 * 4 * 3);
    const bass = planChordPart(project, song.patternId, { bass: true })!;
    expect(bass.notes.filter((n) => n.tick === 0)).toHaveLength(4);
  });

  it('has nothing to write without chords there, and sizes a blank pattern from the chord track', () => {
    expect(planChordPart(song.project, song.patternId)).toBeNull();
    const blank = produce(withChords(['Am', 'F', 'C', 'G', 'Am', 'F']), (draft) => {
      draft.patterns[song.patternId]!.notes = {} as never;
      delete draft.patterns[song.patternId]!.length;
      draft.playlist.clips = {} as never;
    });
    expect(partLength(blank, song.patternId)).toBe(6 * BAR);
    expect(planChordPart(blank, song.patternId)!.chordCount).toBe(6);
    expect(partLength(blank, song.patternId, 2)).toBe(2 * BAR);
  });

  it('puts a pattern placed later in the song over the chords of those bars', () => {
    const project = produce(withChords(['Am', 'F', 'C', 'G', 'Dm', 'Bb', 'F', 'C']), (draft) => {
      const clip = Object.values(draft.playlist.clips)[0]!;
      clip.start = 4 * BAR;
    });
    const plan = planChordPart(project, song.patternId)!;
    expect(plan.chordCount).toBe(4);
    expect(new Set(plan.notes.filter((n) => n.tick === 0).map((n) => mod12(n.key)))).toEqual(new Set([2, 5, 9]));
  });
});

describe('planning a bassline', () => {
  it('writes roots of the chord track in the bass register', () => {
    const plan = planBassPart(withChords(['Am', 'F', 'C', 'G']), song.patternId, roles, { style: 'roots' })!;
    expect(plan.notes.map((n) => mod12(n.key))).toEqual([9, 5, 0, 7]);
  });

  it('an 808 follows the kick of the pattern it is in, or of another one that plays at the same time', () => {
    const project = withChords(['Am', 'F']);
    const own = findKickPattern(project, song.patternId, roles)!;
    expect(own.kicks).toHaveLength(16);
    expect(own.cycle).toBe(4 * BAR);
    const plan = planBassPart(project, song.patternId, roles, { style: '808', bars: 2 })!;
    // A kick on every beat: a note on every beat, each on the chord's root.
    expect(plan.notes.filter((n) => n.tick < BAR)).toHaveLength(4);
    expect(plan.notes.every((n) => n.key >= 28 && n.key < 40)).toBe(true);
    const noKick = produce(project, (draft) => {
      for (const pattern of Object.values(draft.patterns)) delete pattern.notes[song.channels.kick];
    });
    expect(findKickPattern(noKick, song.patternId, roles)).toBeNull();
    const fallback = planBassPart(noKick, song.patternId, roles, { style: '808', bars: 1 })!;
    expect(fallback.notes.map((n) => n.tick)).toEqual([0, 1440, 2400]);
  });
});

describe('planning a melody fit', () => {
  it('fits notes to the chords under them, by strength', () => {
    const project = withChords(['C', 'F', 'G', 'C']);
    const lead: Note[] = [
      { id: 'n_1' as never, tick: 0, length: 240, key: 62, velocity: 0.8 },
      { id: 'n_2' as never, tick: BAR, length: 240, key: 71, velocity: 0.8 },
      { id: 'n_3' as never, tick: BAR + 240, length: 240, key: 61, velocity: 0.8 },
    ];
    const all = planMelodyFit(project, song.patternId, lead, { strength: 1 });
    expect(all.off).toBe(3);
    expect(all.changes.map((c) => c.id)).toEqual(['n_1', 'n_2', 'n_3']);
    expect([60, 64]).toContain(all.changes[0]!.key);
    expect([69, 72]).toContain(all.changes[1]!.key);
    expect(planMelodyFit(project, song.patternId, lead, { strength: 0 }).changes).toEqual([]);
    expect(planMelodyFit(project, song.patternId, lead, { strength: 0.34 }).changes).toHaveLength(2);
  });

  it('reports notes that sit over no chord', () => {
    const plan = planMelodyFit(song.project, song.patternId, [{ id: 'n_1' as never, tick: 0, length: 240, key: 62, velocity: 0.8 }], { strength: 1 });
    expect(plan.withoutChord).toBe(1);
    expect(plan.changes).toEqual([]);
  });
});
