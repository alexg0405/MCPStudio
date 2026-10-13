import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  chordName,
  chordNotes,
  CHORDS,
  detectChord,
  diatonicChord,
  diatonicQuality,
  fitKeys,
  getChord,
  invert,
  voice,
  VOICINGS,
} from './chords';
import { noteName, pitchClass } from './scales';

const chordId = fc.constantFrom(...CHORDS.map((c) => c.id));
const pcs = (keys: readonly number[]) => [...new Set(keys.map(pitchClass))].sort((a, b) => a - b);

describe('chords', () => {
  it('are well formed', () => {
    expect(new Set(CHORDS.map((c) => c.id)).size).toBe(CHORDS.length);
    for (const c of CHORDS) expect(c.intervals[0]).toBe(0);
    expect(getChord('??').id).toBe('major');
    for (const id of ['major', 'minor', 'dim', 'aug', 'sus2', 'sus4', '6', 'm6', '7', 'maj7', 'm7', 'm7b5', 'dim7'])
      expect(getChord(id).id).toBe(id);
    for (const id of ['9', 'maj9', 'm9', 'add9', '11', '13', 'power']) expect(getChord(id).id).toBe(id);
  });

  it('builds chords, inversions and voicings', () => {
    expect(chordNotes(60, 'major').map(noteName)).toEqual(['C5', 'E5', 'G5']);
    expect(chordNotes(60, 'm7', { inversion: 1 }).map(noteName)).toEqual(['D#5', 'G5', 'A#5', 'C6']);
    expect(chordNotes(60, 'major', { inversion: -1 })).toEqual([55, 60, 64]);
    expect(voice([60, 64, 67], 'open')).toEqual([60, 67, 76]);
    expect(voice([60, 64, 67, 71], 'drop2')).toEqual([55, 60, 64, 71]);
    expect(voice([60, 64, 67, 71], 'drop3')).toEqual([52, 60, 67, 71]);
    expect(voice([60, 64, 67], 'bass')).toEqual([48, 60, 64, 67]);
    expect(chordName(1, 'm7b5')).toBe('C#m7b5');
    expect(fitKeys([130, -3, 60, 60])).toEqual([9, 60, 118]);
  });

  it('keeps the chord pitch classes through inversions and voicings', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 24, max: 96 }),
        chordId,
        fc.integer({ min: -3, max: 3 }),
        fc.constantFrom(...VOICINGS),
        (root, id, inv, v) => {
          const keys = chordNotes(root, id, { inversion: inv, voicing: v });
          expect(pcs(keys)).toEqual(pcs(getChord(id).intervals.map((i) => root + i)));
          for (const k of keys) {
            expect(k).toBeGreaterThanOrEqual(0);
            expect(k).toBeLessThanOrEqual(127);
          }
        },
      ),
    );
  });

  it('inverting a chord within an octave by its size moves it up an octave', () => {
    const small = CHORDS.filter((c) => (c.intervals[c.intervals.length - 1] as number) < 12);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.constantFrom(...small), (root, chord) => {
        const keys = chord.intervals.map((i) => root + i);
        expect(invert(keys, keys.length)).toEqual(keys.map((k) => k + 12));
        expect(invert(invert(keys, 2), -2)).toEqual(keys);
      }),
    );
  });

  it('names the chords it builds', () => {
    // In root position the bass decides between readings (C6 vs Am7); power8 reads as a power chord.
    const named = CHORDS.filter((c) => c.id !== 'power8').map((c) => c.id);
    fc.assert(
      fc.property(fc.integer({ min: 36, max: 84 }), fc.constantFrom(...named), (root, id) => {
        const found = detectChord(chordNotes(root, id));
        expect(found?.chord.id).toBe(id);
        expect(found?.root).toBe(pitchClass(root));
      }),
    );
    expect(detectChord([64, 67, 72])?.name).toBe('C/E');
    expect(detectChord([60, 61, 62])).toBeNull();
    expect(detectChord([])).toBeNull();
  });

  it('builds chords from a scale', () => {
    // C major: I = C E G, ii = D F A, vii° = B D F; ii7 = Dm7.
    expect(diatonicChord(60, 0, 'major').map(noteName)).toEqual(['C5', 'E5', 'G5']);
    expect(diatonicChord(62, 0, 'major').map(noteName)).toEqual(['D5', 'F5', 'A5']);
    expect(diatonicChord(61, 0, 'major').map(noteName)).toEqual(['C5', 'E5', 'G5']); // C# snaps down to C
    expect(detectChord(diatonicChord(62, 0, 'major', 4))?.name).toBe('Dm7');
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => diatonicQuality(d, 0, 'major'))).toEqual([
      'major',
      'minor',
      'minor',
      'major',
      'major',
      'minor',
      'dim',
    ]);
    // A harmonic minor's V is major.
    expect(diatonicQuality(4, 9, 'harmonic-minor')).toBe('major');
  });
});
