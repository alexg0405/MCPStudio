import { describe, expect, it } from 'vitest';
import { chordPitchClasses, formatChord, keyUsesFlats, parseChord, parseChordLine, QUALITIES, sameChord, transposeChord } from './chord';

describe('chord symbols', () => {
  it('reads what people type', () => {
    expect(parseChord('C')).toEqual({ root: 0, quality: 'maj' });
    expect(parseChord('Am7')).toEqual({ root: 9, quality: 'm7' });
    expect(parseChord('F/C')).toEqual({ root: 5, quality: 'maj', bass: 0 });
    expect(parseChord('Bbmaj7')).toEqual({ root: 10, quality: 'maj7' });
    expect(parseChord('C#m7b5')).toEqual({ root: 1, quality: 'm7b5' });
    expect(parseChord('Gsus4')).toEqual({ root: 7, quality: 'sus4' });
    expect(parseChord('Dadd9')).toEqual({ root: 2, quality: 'add9' });
    expect(parseChord('C°7')).toEqual({ root: 0, quality: 'dim7' });
    expect(parseChord('Cø')).toEqual({ root: 0, quality: 'm7b5' });
    expect(parseChord('CM7')).toEqual({ root: 0, quality: 'maj7' });
    expect(parseChord('Cm(maj7)')).toEqual({ root: 0, quality: 'mMaj7' });
    expect(parseChord('E♭')).toEqual({ root: 3, quality: 'maj' });
    expect(parseChord('Am/G')).toEqual({ root: 9, quality: 'min', bass: 7 });
    expect(parseChord('C6/9')).toBeNull();
    expect(parseChord('C/C')).toEqual({ root: 0, quality: 'maj' });
  });

  it('rejects what is not a chord', () => {
    for (const t of ['', 'hello', 'H', 'Cxyz', 'add9', 'dim', 'C/']) expect(parseChord(t), t).toBeNull();
  });

  it('round-trips every quality on every root, with and without a slash bass', () => {
    for (const flats of [false, true])
      for (const q of QUALITIES)
        for (let root = 0; root < 12; root++)
          for (const bass of [undefined, (root + 4) % 12]) {
            const c = { root, quality: q.id, ...(bass !== undefined ? { bass } : {}) };
            const text = formatChord(c, flats);
            expect(parseChord(text), text).toEqual(c);
            expect(formatChord(parseChord(text)!, flats)).toBe(text);
          }
  });

  it('names notes with flats in flat keys', () => {
    expect(formatChord({ root: 10, quality: 'maj7' }, true)).toBe('Bbmaj7');
    expect(formatChord({ root: 10, quality: 'maj7' })).toBe('A#maj7');
    expect(keyUsesFlats(5, 'major')).toBe(true);
    expect(keyUsesFlats(7, 'major')).toBe(false);
    expect(keyUsesFlats(2, 'minor')).toBe(true);
    expect(keyUsesFlats(9, 'minor')).toBe(false);
  });

  it('lists the notes of a chord and treats a bass equal to the root as none', () => {
    expect(chordPitchClasses({ root: 9, quality: 'm7' })).toEqual([9, 0, 4, 7]);
    expect(chordPitchClasses({ root: 0, quality: 'add9' })).toEqual([0, 4, 7, 2]);
    expect(sameChord({ root: 0, quality: 'maj', bass: 0 }, { root: 0, quality: 'maj' })).toBe(true);
    expect(sameChord({ root: 0, quality: 'maj', bass: 4 }, { root: 0, quality: 'maj' })).toBe(false);
    expect(transposeChord({ root: 10, quality: 'min', bass: 5 }, 3)).toEqual({ root: 1, quality: 'min', bass: 8 });
  });

  it('reads a typed progression', () => {
    const r = parseChordLine('Am7 | F | C | G7, ., Dm x');
    expect(r.chords.map((c) => (c ? c.root : null))).toEqual([9, 5, 0, 7, null, 2]);
    expect(r.bad).toEqual(['x']);
  });
});
