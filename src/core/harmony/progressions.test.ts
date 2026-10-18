import { describe, expect, it } from 'vitest';
import { formatChord, keyUsesFlats, parseChord } from './chord';
import {
  findProgressions,
  layoutProgression,
  lookupProgression,
  parseRoman,
  PROGRESSIONS,
  progressionChords,
  suggestNext,
  withSeventh,
} from './progressions';
import { degreeOf, diatonicChord, diatonicChords, harmonicScale, keyMode, romanOf, scalePitchClasses } from './scale';

const A_MINOR = { root: 9, scale: 'minor' };
const C_MAJOR = { root: 0, scale: 'major' };
const names = (list: { chord: Parameters<typeof formatChord>[0] }[], flats = false) => list.map((x) => formatChord(x.chord, flats)).join(' ');

describe('scales and diatonic chords', () => {
  it('builds the triads and sevenths of a key', () => {
    expect(diatonicChords(C_MAJOR).map((c) => formatChord(c)).join(' ')).toBe('C Dm Em F G Am Bdim');
    expect(diatonicChords(C_MAJOR, true).map((c) => formatChord(c)).join(' ')).toBe('Cmaj7 Dm7 Em7 Fmaj7 G7 Am7 Bm7b5');
    expect(diatonicChords(A_MINOR).map((c) => formatChord(c)).join(' ')).toBe('Am Bdim C Dm Em F G');
    expect(formatChord(diatonicChord({ root: 2, scale: 'dorian' }, 3))).toBe('G');
  });

  it('knows the mode and the notes of a key', () => {
    expect(keyMode('minor')).toBe('minor');
    expect(keyMode('dorian')).toBe('minor');
    expect(keyMode('major-pentatonic')).toBe('major');
    expect(keyMode('minor-pentatonic')).toBe('minor');
    expect(harmonicScale('minor-pentatonic')).toEqual(harmonicScale('minor'));
    expect(scalePitchClasses(C_MAJOR)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses({ root: 9, scale: 'minor-pentatonic' })).toEqual([9, 0, 2, 4, 7]);
    expect(degreeOf(A_MINOR, 7)).toBe(6);
    expect(degreeOf(A_MINOR, 8)).toBe(-1);
  });

  it('names chords as Roman numerals in the key', () => {
    expect(romanOf(C_MAJOR, parseChord('Am')!)).toBe('vi');
    expect(romanOf(C_MAJOR, parseChord('G7')!)).toBe('V7');
    expect(romanOf(C_MAJOR, parseChord('Bb')!)).toBe('bVII');
    expect(romanOf(C_MAJOR, parseChord('Bdim')!)).toBe('vii°');
    expect(romanOf(A_MINOR, parseChord('F')!)).toBe('VI');
  });
});

describe('progressions', () => {
  it('reads Roman numerals in a key', () => {
    expect(formatChord(parseRoman('vi', C_MAJOR)!)).toBe('Am');
    expect(formatChord(parseRoman('bVII', C_MAJOR)!, true)).toBe('Bb');
    expect(formatChord(parseRoman('V7', C_MAJOR)!)).toBe('G7');
    expect(formatChord(parseRoman('ii7', C_MAJOR)!)).toBe('Dm7');
    expect(formatChord(parseRoman('Imaj7', C_MAJOR)!)).toBe('Cmaj7');
    expect(formatChord(parseRoman('iiø7', A_MINOR)!)).toBe('Bm7b5');
    expect(formatChord(parseRoman('VI', A_MINOR)!)).toBe('F');
    expect(formatChord(parseRoman('V', A_MINOR)!)).toBe('E');
    expect(formatChord(parseRoman('bII', A_MINOR)!)).toBe('A#');
    expect(parseRoman('xyz', C_MAJOR)).toBeNull();
  });

  it('turns the palette into chords in any key', () => {
    const axis = lookupProgression('pop-axis')!;
    expect(names(progressionChords(axis, { root: 7, scale: 'major' }))).toBe('G D Em C');
    expect(names(progressionChords(lookupProgression('minor-epic')!, A_MINOR))).toBe('Am F C G');
    expect(names(progressionChords(lookupProgression('minor-epic')!, { root: 5, scale: 'minor' }), keyUsesFlats(5, 'minor'))).toBe('Fm Db Ab Eb');
    expect(names(progressionChords(lookupProgression('andalusian')!, A_MINOR))).toBe('Am G F E');
  });

  it('every palette entry resolves in every key and mode it is written for', () => {
    for (const p of PROGRESSIONS) {
      expect(progressionChords(p, p.mode === 'major' ? C_MAJOR : A_MINOR).length, p.id).toBe(p.chords.length);
      expect(p.note.length, p.id).toBeGreaterThan(10);
    }
    expect(new Set(PROGRESSIONS.map((p) => p.id)).size).toBe(PROGRESSIONS.length);
  });

  it('finds progressions by mood, genre and mode', () => {
    expect(findProgressions({ genre: 'trap', mode: 'minor' }).length).toBeGreaterThanOrEqual(3);
    expect(findProgressions({ mood: 'chill', genre: 'lofi' }).map((p) => p.id)).toContain('lofi-maj');
    expect(findProgressions({ genre: 'blues' }).map((p) => p.id)).toContain('blues-12');
    expect(findProgressions({ text: 'canon' }).length).toBe(1);
    expect(lookupProgression('12-bar blues')?.chords).toHaveLength(12);
  });

  it('lays a progression out in time, repeating to fill the bars', () => {
    const bar = 3840;
    const built = layoutProgression(lookupProgression('pop-axis')!, C_MAJOR, { startTick: bar * 8, bar, bars: 8 });
    expect(built).toHaveLength(8);
    expect(built[0]).toMatchObject({ tick: bar * 8, length: bar });
    expect(built[7]!.tick).toBe(bar * 15);
    const trap = layoutProgression(lookupProgression('trap-three')!, A_MINOR, { startTick: 0, bar, bars: 8 });
    // 2+1+1 bars per pass, twice.
    expect(trap.map((b) => b.length / bar)).toEqual([2, 1, 1, 2, 1, 1]);
    const cut = layoutProgression(lookupProgression('trap-two')!, A_MINOR, { startTick: 0, bar, bars: 3 });
    expect(cut.map((b) => b.length / bar)).toEqual([2, 1]);
  });

  it('merges repeated neighbours and can turn triads into sevenths', () => {
    const bar = 3840;
    const merged = layoutProgression(lookupProgression('ii-v-i')!, C_MAJOR, { startTick: 0, bar });
    expect(merged.map((b) => [formatChord(b.chord), b.length / bar])).toEqual([['Dm7', 1], ['G7', 1], ['Cmaj7', 2]]);
    const sev = layoutProgression(lookupProgression('pop-axis')!, C_MAJOR, { startTick: 0, bar, sevenths: true });
    expect(sev.map((b) => formatChord(b.chord)).join(' ')).toBe('Cmaj7 G7 Am7 Fmaj7');
    expect(formatChord(withSeventh(parseChord('Bdim')!, C_MAJOR))).toBe('Bm7b5');
  });
});

describe('what comes next', () => {
  it('ranks the move home first after the dominant, and offers the deceptive one', () => {
    const next = suggestNext(C_MAJOR, parseChord('G')!);
    expect(formatChord(next[0]!.chord)).toBe('C');
    expect(next[0]!.reason).toContain('home');
    expect(next.map((n) => formatChord(n.chord))).toContain('Am');
    expect(next.find((n) => formatChord(n.chord) === 'Am')!.reason).toContain('deceptive');
    expect(next.every((n, i) => i === 0 || next[i - 1]!.score >= n.score)).toBe(true);
  });

  it('builds tension from the subdominant and never repeats the chord just played', () => {
    const next = suggestNext(C_MAJOR, parseChord('F')!);
    expect(['G', 'C']).toContain(formatChord(next[0]!.chord));
    expect(next.some((n) => formatChord(n.chord) === 'F')).toBe(false);
    const dm = suggestNext(C_MAJOR, parseChord('Dm')!);
    expect(formatChord(dm[0]!.chord)).toBe('G');
    expect(dm[0]!.function).toBe('dominant');
  });

  it('works in minor, with sevenths, and as a way to open', () => {
    const next = suggestNext(A_MINOR, parseChord('Am')!, { sevenths: true });
    expect(next.map((n) => formatChord(n.chord)).some((n) => /7$/.test(n))).toBe(true);
    const open = suggestNext(A_MINOR, null);
    expect(formatChord(open[0]!.chord)).toBe('Am');
    expect(open[0]!.reason).toContain('key');
    const away = suggestNext(C_MAJOR, parseChord('Eb')!);
    expect(away.length).toBeGreaterThan(0);
  });
});
