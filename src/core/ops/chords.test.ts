import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatChord, parseChord } from '../harmony/chord';
import { createEmptyProject } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import type { ChordId, Project } from '../model/types';
import { migrateProject, repairProject } from '../schema/migrate';
import { chordAt, chordsSorted, chordTrackLines, patternChords } from '../query/chords';
import { clearChords, editChord, MAX_CHORDS, moveChord, placeChords, removeChord, resizeChord, setChord, splitChord, symbolOf, transposeChords } from './chords';

const BAR = 3840;
const chord = (text: string) => parseChord(text)!;
const summary = (project: Project) => chordsSorted(project).map((event) => `${event.tick / BAR}+${event.length / BAR} ${formatChord(symbolOf(event))}`);

beforeEach(() => setIdSource(seededBytes(11)));

describe('chord track edits', () => {
  it('places chords and keeps them from overlapping', () => {
    let project = createEmptyProject();
    project = produce(project, (draft) => {
      setChord(draft, 0, BAR * 4, chord('Am'));
      setChord(draft, BAR, BAR, chord('F'));
    });
    // The F sits inside the Am, which is split around it.
    expect(summary(project)).toEqual(['0+1 Am', '1+1 F', '2+2 Am']);
    project = produce(project, (draft) => void setChord(draft, BAR * 3, BAR * 3, chord('G')));
    expect(summary(project)).toEqual(['0+1 Am', '1+1 F', '2+1 Am', '3+3 G']);
    project = produce(project, (draft) => void setChord(draft, BAR / 2, BAR * 2, chord('C')));
    expect(summary(project)).toEqual(['0+0.5 Am', '0.5+2 C', '2.5+0.5 Am', '3+3 G']);
  });

  it('moves, resizes, splits, edits and removes one chord', () => {
    let project = createEmptyProject();
    let first = '' as ChordId;
    let second = '' as ChordId;
    project = produce(project, (draft) => {
      first = setChord(draft, 0, BAR * 2, chord('Am7'), { confidence: 0.6 });
      second = setChord(draft, BAR * 2, BAR * 2, chord('F'));
    });
    project = produce(project, (draft) => resizeChord(draft, first, 0, BAR * 3));
    expect(summary(project)).toEqual(['0+3 Am7', '3+1 F']);
    project = produce(project, (draft) => moveChord(draft, second, BAR * 2));
    expect(summary(project)).toEqual(['0+2 Am7', '2+1 F']);
    project = produce(project, (draft) => editChord(draft, first, chord('Dm/F')));
    expect(project.chords![first]).toMatchObject({ root: 2, quality: 'min', bass: 5 });
    expect(project.chords![first]!.confidence).toBeUndefined();
    let right: ChordId | null = null;
    project = produce(project, (draft) => {
      right = splitChord(draft, first, BAR);
      expect(splitChord(draft, first, 0)).toBeNull();
    });
    expect(summary(project)).toEqual(['0+1 Dm/F', '1+1 Dm/F', '2+1 F']);
    project = produce(project, (draft) => removeChord(draft, right!));
    expect(summary(project)).toEqual(['0+1 Dm/F', '2+1 F']);
  });

  it('clears all of it or a span, and transposes', () => {
    let project = produce(createEmptyProject(), (draft) => {
      placeChords(draft, [0, 1, 2, 3].map((bar) => ({ tick: bar * BAR, length: BAR, chord: chord(['Am', 'F', 'C', 'G'][bar]!) })));
    });
    expect(summary(project)).toHaveLength(4);
    const shifted = produce(project, (draft) => transposeChords(draft, 2));
    expect(summary(shifted)).toEqual(['0+1 Bm', '1+1 G', '2+1 D', '3+1 A']);
    project = produce(project, (draft) => void clearChords(draft, BAR, BAR * 3));
    expect(summary(project)).toEqual(['0+1 Am', '3+1 G']);
    project = produce(project, (draft) => {
      expect(clearChords(draft)).toBe(2);
    });
    expect(project.chords).toBeUndefined();
  });

  it('caps the track and drops a bass equal to the root', () => {
    const project = produce(createEmptyProject(), (draft) => {
      placeChords(draft, Array.from({ length: MAX_CHORDS + 10 }, (_, i) => ({ tick: i * 10, length: 10, chord: { root: 0, quality: 'maj', bass: 0 } })));
    });
    expect(Object.keys(project.chords!)).toHaveLength(MAX_CHORDS);
    expect(chordsSorted(project)[0]!.bass).toBeUndefined();
  });
});

describe('reading the chord track', () => {
  const song = produce(createEmptyProject(), (draft) => {
    placeChords(draft, [
      { tick: 0, length: BAR, chord: chord('Am7') },
      { tick: BAR, length: BAR / 2, chord: chord('F') },
      { tick: BAR * 1.5, length: BAR / 2, chord: chord('G') },
      { tick: BAR * 3, length: BAR, chord: chord('C') },
    ]);
  });

  it('finds the chord at a tick, with gaps', () => {
    expect(formatChord(symbolOf(chordAt(song, 0)!))).toBe('Am7');
    expect(formatChord(symbolOf(chordAt(song, BAR * 1.75)!))).toBe('G');
    expect(chordAt(song, BAR * 2.5)).toBeNull();
    expect(chordAt(createEmptyProject(), 0)).toBeNull();
  });

  it('writes the compact text the AI reads, merging eight-bar lines that repeat', () => {
    expect(chordTrackLines(song)).toEqual(['bars 1–4: Am7 | F·G | – | C']);
    const long = produce(createEmptyProject(), (draft) => {
      for (const bar of [0, 8, 16]) placeChords(draft, [{ tick: bar * BAR, length: BAR * 8, chord: chord(bar === 8 ? 'F' : 'Am') }]);
    });
    expect(chordTrackLines(long)).toEqual(['bars 1–8, 17–24: Am | Am | Am | Am | Am | Am | Am | Am', 'bars 9–16: F | F | F | F | F | F | F | F']);
    expect(chordTrackLines(createEmptyProject())).toEqual([]);
  });

  it('shows a pattern the chords of the bars it plays', () => {
    const project = produce(song, (draft) => {
      const patternId = draft.patternOrder[0]!;
      const laneId = draft.playlist.laneOrder[0]!;
      draft.playlist.clips['clip_x' as never] = { id: 'clip_x', kind: 'pattern', laneId, patternId, start: BAR, length: BAR * 2, offset: 0 } as never;
      draft.patterns[patternId]!.length = BAR * 2;
    });
    const chords = patternChords(project, project.patternOrder[0]!);
    expect(chords.map((entry) => `${entry.tick}+${entry.length} ${formatChord(entry.chord)}`)).toEqual([`0+${BAR / 2} F`, `${BAR / 2}+${BAR / 2} G`]);
  });
});

describe('the chord track in saved projects', () => {
  const withChords = (chords: unknown) => ({ ...JSON.parse(JSON.stringify(createEmptyProject())), chords });
  const repaired = (chords: unknown) => repairProject(migrateProject(withChords(chords)).project);

  it('keeps a good track exactly as it is', () => {
    const good = { cd_a: { id: 'cd_a', tick: 0, length: BAR, root: 9, quality: 'm7', confidence: 0.8 }, cd_b: { id: 'cd_b', tick: BAR, length: BAR, root: 5, quality: 'maj', bass: 0 } };
    const result = repaired(good);
    expect(result.repairs).toEqual([]);
    expect(result.project.chords).toEqual(good);
  });

  it('drops what cannot be read, clears bad extras and trims overlaps', () => {
    const result = repaired({
      cd_a: { id: 'cd_a', tick: 0, length: BAR * 3, root: 9, quality: 'm7', bass: 40, confidence: 7 },
      cd_b: { id: 'cd_b', tick: BAR, length: BAR, root: 5, quality: 'maj' },
      cd_c: { id: 'cd_c', tick: 0, length: BAR, root: 12, quality: 'maj' },
      cd_d: { id: 'cd_d', tick: 0, length: BAR, root: 0, quality: 'nonsense' },
      cd_e: 'nope',
      cd_f: { id: 'wrong', tick: 0, length: BAR, root: 0, quality: 'maj' },
    });
    expect(Object.values(result.project.chords!).map((event) => [event.tick, event.length])).toEqual([[0, BAR], [BAR, BAR]]);
    expect(result.project.chords![('cd_a' as ChordId)]).toEqual({ id: 'cd_a', tick: 0, length: BAR, root: 9, quality: 'm7' });
    expect(result.repairs.join(' ')).toContain('4 chords');
    expect(repairProject(result.project).repairs).toEqual([]);
  });

  it('forgets a track that is not a record, and an empty one', () => {
    expect(repaired([1, 2]).project.chords).toBeUndefined();
    expect(repaired({}).project.chords).toBeUndefined();
    expect(repaired('x').repairs.join(' ')).toContain('damaged chord track');
  });
});
