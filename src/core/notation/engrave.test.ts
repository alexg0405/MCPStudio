import { describe, expect, it } from 'vitest';
import { bars, note, noteAt, score } from './test-input';

describe('durations, rests and ties', () => {
  it('writes plain quarter notes and fills the bar with a rest', () => {
    expect(bars([note(0, 4, 72), note(4, 4, 74)])).toBe('| C5q D5q rh |');
  });

  it('an empty bar is one whole-bar rest, in any meter', () => {
    expect(bars([], { lengthTicks: 3840 })).toBe('| R |');
    expect(bars([], { lengthTicks: 2880, timeSig: { num: 3, den: 4 } })).toBe('| R |');
  });

  it('eighths, then a dotted quarter from beat 2 that is tied at the middle of the bar', () => {
    expect(bars([note(0, 2, 72), note(2, 2, 74), note(4, 6, 76), note(10, 2, 77)])).toBe('| C5e D5e E5q~ E5e F5e rq |');
  });

  it('cuts a note at the middle of a 4/4 bar and ties it', () => {
    // A half note from beat 2 would cross the middle of the bar: quarter, tied quarter.
    expect(bars([note(4, 8, 72)])).toBe('| rq C5q~ C5q rq |');
  });

  it('a whole note and a dotted half need no tie', () => {
    expect(bars([note(0, 16, 60)])).toBe('| C4w |');
    expect(bars([note(0, 12, 60)])).toBe('| C4h. rq |');
  });

  it('a note over the bar line is tied across it', () => {
    expect(bars([note(12, 8, 60)], { lengthTicks: 7680 })).toBe('| rh. C4q~ | C4q rq rh |');
  });

  it('syncopation: an eighth rest then a quarter that runs over the beat', () => {
    expect(bars([note(2, 4, 60)])).toBe('| re C4q re rh |');
  });

  it('rests are merged to the strong beats: a half rest only from beat 1 or 3, never across the middle', () => {
    expect(bars([note(0, 4, 60), note(12, 4, 60)])).toBe('| C4q rq rq C4q |');
    expect(bars([note(0, 4, 60), note(4, 4, 60)])).toBe('| C4q C4q rh |');
    expect(bars([note(8, 4, 60)])).toBe('| rh C4q rq |');
  });

  it('3/4: three quarters, and a half note on beat 2 stays one note', () => {
    const three = { timeSig: { num: 3, den: 4 }, lengthTicks: 2880 };
    expect(bars([note(0, 4, 60), note(4, 4, 62), note(8, 4, 64)], three)).toBe('| C4q D4q E4q |');
    expect(bars([note(0, 4, 60), note(4, 8, 62)], three)).toBe('| C4q D4h |');
  });

  it('6/8: a dotted quarter per group and eighths in threes', () => {
    const six = { timeSig: { num: 6, den: 8 }, lengthTicks: 2880 };
    expect(bars([note(0, 6, 60), note(6, 6, 62)], six)).toBe('| C4q. D4q. |');
    expect(bars([note(0, 2, 60), note(2, 2, 62), note(4, 2, 64), note(6, 6, 65)], six)).toBe('| C4e D4e E4e F4q. |');
  });

  it('6/8: a quarter that would run over the middle group line is split', () => {
    const six = { timeSig: { num: 6, den: 8 }, lengthTicks: 2880 };
    expect(bars([note(4, 4, 60)], six)).toBe('| rq C4e~ C4e re re |');
  });
});

describe('grids and triplets', () => {
  it('rounds slightly early or late notes to the grid', () => {
    expect(bars([noteAt(10, 230, 60), noteAt(250, 235, 62)])).toBe(bars([note(0, 1, 60), note(1, 1, 62)]));
  });

  it('a 1/8 grid turns sixteenths into eighths', () => {
    expect(bars([note(0, 1, 60), note(1, 1, 62)], { grid: '1/8' })).toBe('| C4e D4e rq rh |');
  });

  it('a 1/32 grid keeps thirty-seconds', () => {
    expect(bars([note(0, 0.5, 60), note(0.5, 0.5, 62)], { grid: '1/32' })).toContain('C4t D4t');
  });

  it('finds eighth-note triplets', () => {
    const triplet = [noteAt(0, 320, 60), noteAt(320, 320, 62), noteAt(640, 320, 64), noteAt(960, 960, 65)];
    expect(bars(triplet)).toBe('| C4e3 D4e3 E4e3 F4q rh |');
    const s = score(triplet);
    const first = s.measures[0]!.staves[0]!.voices[0]!.items[0]!;
    expect(first.tuplet).toEqual({ actual: 3, normal: 2, spanTick: 0, spanTicks: 960 });
  });

  it('sixteenth-note triplets in a beat', () => {
    const sextuplet = [0, 160, 320, 480, 640, 800].map((tick, i) => noteAt(tick, 160, 60 + i));
    expect(bars(sextuplet)).toBe('| C4s3 C#4s3 D4s3 Eb4s3 E4s3 F4s3 rq rh |');
  });

  it('a triplet with a rest inside it', () => {
    expect(bars([noteAt(0, 320, 60), noteAt(640, 320, 64)])).toBe('| C4e3 re3 E4e3 rq rh |');
  });

  it('straight beats stay straight next to a triplet beat', () => {
    const notes = [noteAt(0, 480, 60), noteAt(480, 480, 62), noteAt(960, 320, 64), noteAt(1280, 320, 65), noteAt(1600, 320, 67)];
    expect(bars(notes)).toBe('| C4e D4e E4e3 F4e3 G4e3 rh |');
  });
});

describe('accidentals and key signatures', () => {
  it('names the key signature', () => {
    expect(score([note(0, 4, 60)], { key: { root: 7, scale: 'major' } }).keySignature).toEqual({ fifths: 1, name: 'G major' });
    expect(score([note(0, 4, 60)], { key: { root: 9, scale: 'minor' } }).keySignature).toEqual({ fifths: 0, name: 'A minor' });
    expect(score([note(0, 4, 60)], { key: { root: 3, scale: 'major' } }).keySignature).toEqual({ fifths: -3, name: 'Eb major' });
    expect(score([note(0, 4, 60)], { key: { root: 2, scale: 'dorian' } }).keySignature.fifths).toBe(0);
    expect(score([note(0, 4, 60)]).keySignature.name).toBe('C major');
  });

  it('spells black keys with sharps in a sharp key and flats in a flat key', () => {
    expect(bars([note(0, 4, 66)], { key: { root: 7, scale: 'major' } })).toContain('F#4');
    expect(bars([note(0, 4, 70)], { key: { root: 5, scale: 'major' } })).toContain('Bb4');
    expect(bars([note(0, 4, 61)], { key: { root: 3, scale: 'major' } })).toContain('Db4');
    expect(bars([note(0, 4, 61)], { key: { root: 2, scale: 'major' } })).toContain('C#4');
  });

  it('shows a sign only when a note differs from the key signature, and a natural to cancel it', () => {
    const inG = { key: { root: 7, scale: 'major' } };
    const s = score([note(0, 4, 66), note(4, 4, 65), note(8, 4, 66), note(12, 4, 65)], inG);
    const signs = s.measures[0]!.staves[0]!.voices[0]!.items.filter((item) => item.kind === 'chord').map((item) => (item.kind === 'chord' ? item.heads[0]!.accidental : null));
    // F# is in G major's signature: no sign. F natural needs a natural; the F# after it needs its sharp again.
    expect(signs).toEqual([null, 'natural', 'sharp', 'natural']);
  });

  it('a sharp holds for the rest of the bar and is forgotten after the bar line, with a courtesy sign', () => {
    const s = score([note(0, 4, 61), note(4, 4, 61), note(16, 4, 60)], { lengthTicks: 7680 });
    const first = s.measures[0]!.staves[0]!.voices[0]!.items;
    const heads = first.flatMap((item) => (item.kind === 'chord' ? item.heads : []));
    expect(heads.map((head) => head.accidental)).toEqual(['sharp', null]);
    const second = s.measures[1]!.staves[0]!.voices[0]!.items.find((item) => item.kind === 'chord');
    expect(second?.kind === 'chord' && second.heads[0]?.accidental).toBe('natural');
    expect(second?.kind === 'chord' && second.heads[0]?.isCourtesy).toBe(true);
  });

  it('a tied note shows its sign only once', () => {
    const s = score([note(4, 8, 61)]);
    const chords = s.measures[0]!.staves[0]!.voices[0]!.items.filter((item) => item.kind === 'chord');
    expect(chords).toHaveLength(2);
    expect(chords.map((item) => (item.kind === 'chord' ? item.heads[0]!.accidental : 'x'))).toEqual(['sharp', null]);
  });

  it('the raised seventh of a harmonic minor key is spelled with the scale letters', () => {
    // D harmonic minor: C sharp, not D flat.
    expect(bars([note(0, 4, 61)], { key: { root: 2, scale: 'harmonic-minor' } })).toContain('C#4');
  });
});

describe('clefs', () => {
  it('uses treble for high notes, bass for low notes and a grand staff for a wide range', () => {
    expect(score([note(0, 4, 72)]).clefs).toEqual(['treble']);
    expect(score([note(0, 4, 40)]).clefs).toEqual(['bass']);
    expect(score([note(0, 4, 40), note(4, 4, 79)]).clefs).toEqual(['treble', 'bass']);
  });

  it('puts notes at middle C and above on the top staff of a grand staff', () => {
    const s = score([note(0, 4, 40), note(0, 4, 60), note(0, 4, 79)]);
    const top = s.measures[0]!.staves[0]!.voices[0]!.items[0]!;
    const bottom = s.measures[0]!.staves[1]!.voices[0]!.items[0]!;
    expect(top.kind === 'chord' && top.heads.map((head) => head.key)).toEqual([60, 79]);
    expect(bottom.kind === 'chord' && bottom.heads.map((head) => head.key)).toEqual([40]);
  });
});

describe('chords, voices, beams and stems', () => {
  it('stacks notes that start and end together into one chord', () => {
    expect(bars([note(0, 4, 60), note(0, 4, 64), note(0, 4, 67)])).toBe('| [C4 E4 G4]q rq rh |');
  });

  it('a long note under shorter ones makes two voices', () => {
    const s = score([note(0, 16, 60), note(0, 4, 72), note(4, 4, 74), note(8, 8, 76)]);
    const staves = s.measures[0]!.staves;
    expect(staves.flatMap((staff) => staff.voices.map((voice) => voice.number))).toEqual([1, 2]);
    expect(bars([note(0, 16, 60), note(0, 4, 72), note(4, 4, 74), note(8, 8, 76)])).toContain(' & ');
  });

  it('a legato line that runs a sixteenth into the next note stays one voice', () => {
    const s = score([note(0, 5, 72), note(4, 4, 74)]);
    expect(s.measures[0]!.staves[0]!.voices).toHaveLength(1);
    expect(s.simplified).toBe(0);
  });

  it('beams eighths inside a beat, not across beats', () => {
    const s = score([0, 2, 4, 6].map((step, i) => note(step, 2, 72 + i)));
    const items = s.measures[0]!.staves[0]!.voices[0]!.items.filter((item) => item.kind === 'chord');
    const ids = items.map((item) => (item.kind === 'chord' ? item.beamId : null));
    expect(ids).toEqual([0, 0, 1, 1]);
  });

  it('beams in threes in 6/8', () => {
    const six = { timeSig: { num: 6, den: 8 }, lengthTicks: 2880 };
    const s = score([0, 2, 4, 6, 8, 10].map((step, i) => note(step, 2, 72 + i)), six);
    const ids = s.measures[0]!.staves[0]!.voices[0]!.items.map((item) => (item.kind === 'chord' ? item.beamId : null));
    expect(ids).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('stems point down for notes above the middle line and up below it', () => {
    const s = score([note(0, 4, 79), note(4, 4, 62)], { clef: 'treble' });
    const items = s.measures[0]!.staves[0]!.voices[0]!.items.filter((item) => item.kind === 'chord');
    expect(items.map((item) => (item.kind === 'chord' ? item.stem : null))).toEqual(['down', 'up']);
  });

  it('moves one note of a second to the other side of the stem (the lower one when stems point down)', () => {
    const s = score([note(0, 4, 72), note(0, 4, 74)]);
    const chord = s.measures[0]!.staves[0]!.voices[0]!.items[0]!;
    expect(chord.kind === 'chord' && chord.heads.map((head) => head.isDisplaced)).toEqual([true, false]);
  });

  it('dynamics come from velocities', () => {
    const quiet = { ...note(0, 4, 72), velocity: 0.3 };
    const loud = { ...note(4, 4, 74), velocity: 0.95 };
    const loud2 = { ...note(8, 4, 76), velocity: 0.95 };
    const s = score([quiet, loud, loud2], { dynamics: true });
    const marks = s.measures[0]!.staves[0]!.voices[0]!.items.map((item) => (item.kind === 'chord' ? item.dynamic : null));
    expect(marks).toEqual(['p', 'ff', null, null]);
  });
});

describe('drums', () => {
  it('writes kick, snare and hats on a percussion staff with hands and feet in separate voices', () => {
    const kick = noteAt(0, 120, 36);
    const hat1 = noteAt(0, 120, 42);
    const snare = noteAt(960, 120, 38);
    const hat2 = noteAt(480, 120, 42);
    const hat3 = noteAt(960, 120, 42);
    const s = score([kick, hat1, snare, hat2, hat3], { isPercussion: true });
    expect(s.clefs).toEqual(['percussion']);
    const voices = s.measures[0]!.staves[0]!.voices;
    expect(voices.map((voice) => voice.number)).toEqual([1, 2]);
    expect(bars([kick, hat1, snare, hat2, hat3], { isPercussion: true })).toBe('| hat:e hat:e [snare hat]:q rh & kick:q rq rh |');
    const first = voices[0]!.items[0]!;
    expect(first.kind === 'chord' && first.heads[0]!.shape).toBe('x');
  });

  it('a 16th-note hat pattern reads as sixteenths with the kick below', () => {
    const hats = Array.from({ length: 16 }, (_, i) => noteAt(i * 240, 100, 42));
    const text = bars([...hats, noteAt(0, 100, 36), noteAt(2400, 100, 36)], { isPercussion: true });
    expect(text.startsWith('| hat:s')).toBe(true);
    expect(text).toContain(' & kick:q');
  });
});
