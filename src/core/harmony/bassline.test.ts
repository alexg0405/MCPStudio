import { describe, expect, it } from 'vitest';
import { mod12, parseChord } from './chord';
import { makeBassline, type BassChord, type BassStyle } from './bassline';
import { fitMelody, isStrongBeat } from './fit-melody';

const BAR = 3840;
const BEAT = 960;
const chords = (text: string, bars = 1): BassChord[] =>
  text.split(' ').map((t, i) => ({ tick: i * bars * BAR, length: bars * BAR, chord: parseChord(t)! }));
const opts = (style: BassStyle, extra = {}) => ({ style, bar: BAR, beat: BEAT, ...extra });

describe('bassline', () => {
  it('roots: a root per chord, held, in the bass register', () => {
    const notes = makeBassline(chords('Am F C G'), opts('roots'));
    expect(notes.map((n) => mod12(n.key))).toEqual([9, 5, 0, 7]);
    expect(notes.every((n) => n.key >= 33 && n.key < 45)).toBe(true);
    expect(notes.map((n) => n.tick)).toEqual([0, BAR, 2 * BAR, 3 * BAR]);
    expect(notes.every((n) => n.length > BAR * 0.9 && n.length <= BAR)).toBe(true);
  });

  it('roots: a long chord restarts at every bar line', () => {
    const notes = makeBassline(chords('Am F', 2), opts('roots'));
    expect(notes.map((n) => n.tick)).toEqual([0, BAR, 2 * BAR, 3 * BAR]);
  });

  it('roots use the slash bass', () => {
    const notes = makeBassline([{ tick: 0, length: BAR, chord: parseChord('F/C')! }], opts('roots'));
    expect(mod12(notes[0]!.key)).toBe(0);
  });

  it('root and fifth: alternates on the beats', () => {
    const notes = makeBassline(chords('C G'), opts('root-fifth'));
    const first = notes.filter((n) => n.tick < BAR);
    expect(first.map((n) => mod12(n.key))).toEqual([0, 7, 0, 7]);
    expect(first.map((n) => n.tick)).toEqual([0, BEAT, 2 * BEAT, 3 * BEAT]);
    expect(notes.slice(4).map((n) => mod12(n.key))).toEqual([7, 2, 7, 2]);
  });

  it('walking: quarter notes, root first, an approach note into the next chord, the same every time for a seed', () => {
    const a = makeBassline(chords('Am F C G'), opts('walking', { key: { root: 9, scale: 'minor' }, seed: 3 }));
    const b = makeBassline(chords('Am F C G'), opts('walking', { key: { root: 9, scale: 'minor' }, seed: 3 }));
    expect(a).toEqual(b);
    expect(a).toHaveLength(16);
    for (let bar = 0; bar < 4; bar++) {
      const notes = a.filter((n) => n.tick >= bar * BAR && n.tick < (bar + 1) * BAR);
      const root = mod12(parseChord('Am F C G'.split(' ')[bar]!)!.root);
      expect(mod12(notes[0]!.key)).toBe(root);
      expect(notes.map((n) => n.tick)).toEqual([0, 1, 2, 3].map((i) => bar * BAR + i * BEAT));
      if (bar < 3) {
        const nextRoot = parseChord('Am F C G'.split(' ')[bar + 1]!)!.root;
        const approach = notes[3]!.key;
        // One or two semitones from the next root, in whichever octave is nearest.
        const dist = Math.min(mod12(approach - nextRoot), mod12(nextRoot - approach));
        expect(dist, `bar ${bar + 1}`).toBeGreaterThanOrEqual(1);
        expect(dist, `bar ${bar + 1}`).toBeLessThanOrEqual(2);
      }
    }
    // Stays in the bass register.
    expect(a.every((n) => n.key >= 33 && n.key <= 52)).toBe(true);
    expect(makeBassline(chords('Am F C G'), opts('walking', { seed: 4 }))).not.toEqual(makeBassline(chords('Am F C G'), opts('walking', { seed: 99 })));
  });

  it('808: hits where the kick hits, holds to the next hit and changes pitch with the chord', () => {
    const kicks = [0, 6 * 240, 10 * 240];
    const notes = makeBassline(chords('Am F'), opts('808', { kicks, cycle: BAR }));
    expect(notes.map((n) => n.tick)).toEqual([0, 1440, 2400, BAR, BAR + 1440, BAR + 2400]);
    expect(notes.slice(0, 3).map((n) => mod12(n.key))).toEqual([9, 9, 9]);
    expect(notes.slice(3).map((n) => mod12(n.key))).toEqual([5, 5, 5]);
    expect(notes.every((n) => n.key >= 28 && n.key < 40)).toBe(true);
    // Each note stops before the next one starts.
    notes.forEach((n, i) => i < notes.length - 1 && expect(n.tick + n.length).toBeLessThanOrEqual(notes[i + 1]!.tick));
  });

  it('808: a chord change starts a note even where the kick does not, and a default pattern fills in with no kick', () => {
    const off = makeBassline(chords('Am F'), opts('808', { kicks: [240 * 6], cycle: BAR }));
    expect(off.some((n) => n.tick === BAR && mod12(n.key) === 5)).toBe(true);
    const dflt = makeBassline(chords('Am'), opts('808'));
    expect(dflt.map((n) => n.tick)).toEqual([0, 1440, 2400]);
  });

  it('808: a kick only every other bar still plays the chord of the bar it falls in', () => {
    const notes = makeBassline(chords('Am Am F F'), opts('808', { kicks: [0], cycle: 2 * BAR }));
    expect(notes.filter((n) => n.tick >= 2 * BAR).every((n) => mod12(n.key) === 5)).toBe(true);
  });

  it('stops at the end it is given', () => {
    const notes = makeBassline(chords('Am F'), opts('root-fifth', { end: BAR + BEAT }));
    expect(Math.max(...notes.map((n) => n.tick + n.length))).toBeLessThanOrEqual(BAR + BEAT);
  });
});

describe('fit melody to chords', () => {
  const chordAt = (t: number) => (t < BAR ? parseChord('C') : parseChord('F'));
  const key = { root: 0, scale: 'major' };
  const note = (tick: number, k: number, length = 240) => ({ tick, length, key: k });

  it('knows the strong beats', () => {
    expect([0, 2 * BEAT].every((t) => isStrongBeat(t, BEAT))).toBe(true);
    expect([BEAT, 3 * BEAT, 240, 480].some((t) => isStrongBeat(t, BEAT))).toBe(false);
    expect(isStrongBeat(BAR, BEAT)).toBe(true);
    expect(isStrongBeat(40, BEAT)).toBe(true);
  });

  it('moves strong notes to chord tones and weak notes to scale tones', () => {
    const notes = [
      note(0, 62), // D over C on beat 1: to C or E
      note(240, 61), // C# off the beat: to the scale (C or D)
      note(2 * BEAT, 66), // F# on beat 3 over C: to G
      note(BAR, 71), // B over F on a bar start: to A or C
    ];
    const r = fitMelody(notes, { chordAt, key, strength: 1, beat: BEAT });
    expect([60, 64]).toContain(r.keys[0]);
    expect([60, 62]).toContain(r.keys[1]);
    expect(r.keys[2]).toBe(67);
    expect([69, 72]).toContain(r.keys[3]);
    expect(r.off).toBe(4);
    expect(r.moved).toBe(4);
  });

  it('leaves notes that already fit alone, and long notes count as strong', () => {
    const fine = [note(0, 64), note(BEAT, 62), note(2 * BEAT, 67)];
    expect(fitMelody(fine, { chordAt, key, strength: 1, beat: BEAT }).moved).toBe(0);
    const long = fitMelody([note(BEAT, 62, BEAT * 2)], { chordAt, key, strength: 1, beat: BEAT });
    expect([60, 64]).toContain(long.keys[0]);
  });

  it('strength fixes the smallest moves first and 100% is idempotent', () => {
    const notes = [note(0, 62), note(2 * BEAT, 66), note(BAR, 71), note(BAR + 2 * BEAT, 70)];
    const none = fitMelody(notes, { chordAt, key, strength: 0, beat: BEAT });
    expect(none.keys).toEqual(notes.map((n) => n.key));
    const half = fitMelody(notes, { chordAt, key, strength: 0.5, beat: BEAT });
    expect(half.moved).toBe(2);
    const all = fitMelody(notes, { chordAt, key, strength: 1, beat: BEAT });
    expect(all.moved).toBe(4);
    const again = fitMelody(
      notes.map((n, i) => ({ ...n, key: all.keys[i]! })),
      { chordAt, key, strength: 1, beat: BEAT },
    );
    expect(again.moved).toBe(0);
    // Each note moved to a note of the chord, by at most a semitone or two here.
    all.keys.forEach((k, i) => expect(Math.abs(k - notes[i]!.key)).toBeLessThanOrEqual(2));
  });

  it('without a song key only strong notes are fixed; without a chord nothing is', () => {
    const r = fitMelody([note(0, 62), note(240, 61)], { chordAt, key: null, strength: 1, beat: BEAT });
    expect(r.moved).toBe(1);
    expect(r.keys[1]).toBe(61);
    expect(fitMelody([note(0, 62)], { chordAt: () => null, key, strength: 1, beat: BEAT }).moved).toBe(0);
  });
});
