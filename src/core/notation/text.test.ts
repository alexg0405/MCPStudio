import { describe, expect, it } from 'vitest';
import { entryTicks, keyForLetter, movedKey } from './edit';
import { engrave } from './engrave';
import { describeBar, describeEvent, scoreEvents } from './events';
import { formatNotation, parseDuration, parseNotation, parsePitchName } from './text';
import { bars, input, note, noteAt } from './test-input';

const FOUR_FOUR = { num: 4, den: 4 };

describe('compact text', () => {
  it('reads and writes names and values', () => {
    expect(parsePitchName('C4')).toBe(60);
    expect(parsePitchName('F#3')).toBe(54);
    expect(parsePitchName('Bb5')).toBe(82);
    expect(parsePitchName('H4')).toBeNull();
    expect(parseDuration('q')).toBe(960);
    expect(parseDuration('e.')).toBe(720);
    expect(parseDuration('e3')).toBe(320);
    expect(parseDuration('z')).toBeNull();
  });

  it('parses the example from the guide', () => {
    const result = parseNotation('| C4q E4q G4h |', FOUR_FOUR);
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([
      { tick: 0, length: 960, key: 60, isDrum: false },
      { tick: 960, length: 960, key: 64, isDrum: false },
      { tick: 1920, length: 1920, key: 67, isDrum: false },
    ]);
  });

  it('reads chords, rests, ties, two voices and several bars', () => {
    const result = parseNotation('4/4 key=C-major tempo=90\n| [C4 E4 G4]h rh | C4h~ C4q rq & G3w |', FOUR_FOUR);
    expect(result.header).toEqual({ timeSig: FOUR_FOUR, bpm: 90, keyText: 'C-major' });
    expect(result.bars).toBe(2);
    const rows = result.notes.map((n) => `${n.tick}:${n.length}:${n.key}`).sort();
    expect(rows).toEqual(['0:1920:60', '0:1920:64', '0:1920:67', '3840:2880:60', '3840:3840:55'].sort());
  });

  it('says which words it did not understand, and warns about a short bar', () => {
    const result = parseNotation('| C4q zzz D4q |', FOUR_FOUR);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('zzz');
    expect(result.warnings[0]).toContain('bar 1 holds 2 beats but the meter has 4');
  });

  it('reads drums', () => {
    const result = parseNotation('| [kick hat]:e hat:e snare:q rh |', FOUR_FOUR);
    expect(result.notes.map((n) => `${n.tick}:${n.key}`)).toEqual(['0:36', '0:42', '480:42', '960:38']);
    expect(result.notes.every((n) => n.isDrum)).toBe(true);
  });

  it('writes then reads back what it engraved (a round trip through the text)', () => {
    const notes = [note(0, 4, 72), note(4, 2, 74), note(6, 2, 76), note(8, 8, 60), note(8, 8, 64), note(16, 20, 67)];
    const text = bars(notes, { lengthTicks: 7680 });
    const result = parseNotation(text, FOUR_FOUR);
    const expected = notes.map((n) => `${n.tick}:${n.length}:${n.key}`).sort();
    expect(result.notes.map((n) => `${n.tick}:${n.length}:${n.key}`).sort()).toEqual(expected);
    expect(result.warnings).toEqual([]);
  });

  it('round trips triplets and drums', () => {
    const triplet = [noteAt(0, 320, 60), noteAt(320, 320, 62), noteAt(640, 320, 64), noteAt(960, 960, 65)];
    const parsed = parseNotation(bars(triplet), FOUR_FOUR);
    expect(parsed.notes.map((n) => `${n.tick}:${n.length}:${n.key}`)).toEqual(triplet.map((n) => `${n.tick}:${n.length}:${n.key}`));
    const drums = [noteAt(0, 100, 36), noteAt(0, 100, 42), noteAt(960, 100, 38)];
    const drumText = bars(drums, { isPercussion: true });
    expect(parseNotation(drumText, FOUR_FOUR).notes.map((n) => `${n.tick}:${n.key}`).sort()).toEqual(['0:36', '0:42', '960:38']);
  });

  it('formats a header and breaks lines every few bars', () => {
    const score = engrave(input([note(0, 4, 60)], { lengthTicks: 15360, key: { root: 9, scale: 'minor' } }));
    const lines = formatNotation(score, { barsPerLine: 2 }).split('\n');
    expect(lines[0]).toBe('4/4 key=A-minor tempo=120');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('| R | R |');
  });
});

describe('what a screen reader hears', () => {
  it('names bar, beat, note and value', () => {
    const score = engrave(input([note(0, 4, 72), note(6, 2, 73)], { lengthTicks: 3840 }));
    const events = scoreEvents(score);
    expect(describeEvent(score, events[0]!)).toBe('bar 1, beat 1, C 5, quarter note');
    const sharp = events.find((e) => e.noteIds.length > 0 && e.tick === 1440)!;
    expect(describeEvent(score, sharp)).toBe('bar 1, beat 2 and, C sharp 5, eighth note');
  });

  it('describes rests, chords, drums and a bar', () => {
    const score = engrave(input([note(4, 4, 60), note(4, 4, 64)]));
    const events = scoreEvents(score);
    expect(describeEvent(score, events[0]!)).toBe('bar 1, beat 1, quarter rest');
    expect(describeEvent(score, events[1]!)).toBe('bar 1, beat 2, chord C 4 and E 4, quarter note');
    expect(describeBar(score, 0)).toBe('Bar 1: beat 1 quarter rest; beat 2 chord C 4 and E 4 quarter note; beat 3 half rest.');
    const drums = engrave(input([noteAt(0, 100, 36), noteAt(0, 100, 42)], { isPercussion: true }));
    expect(describeEvent(drums, scoreEvents(drums)[0]!)).toContain('closed hi-hat');
  });

  it('a tied note is one stop for the cursor but lights for its whole length', () => {
    const score = engrave(input([note(4, 8, 61)]));
    const events = scoreEvents(score).filter((e) => e.noteIds.length > 0);
    expect(events.map((e) => e.isContinuation)).toEqual([false, true]);
  });
});

describe('editing helpers', () => {
  it('moves by a scale step in the song key, a semitone or an octave', () => {
    const cMajor = { root: 0, scale: 'major' };
    expect(movedKey(60, 1, 'scale', cMajor)).toBe(62);
    expect(movedKey(64, 1, 'scale', cMajor)).toBe(65);
    expect(movedKey(60, -1, 'scale', cMajor)).toBe(59);
    expect(movedKey(61, 1, 'scale', cMajor)).toBe(62);
    expect(movedKey(61, -1, 'scale', cMajor)).toBe(60);
    expect(movedKey(60, 1, 'scale', { root: 9, scale: 'minor' })).toBe(62);
    expect(movedKey(60, 1, 'semitone', cMajor)).toBe(61);
    expect(movedKey(60, -1, 'octave', cMajor)).toBe(48);
    expect(movedKey(127, 1, 'semitone', cMajor)).toBe(127);
  });

  it('turns duration keys into ticks', () => {
    expect(entryTicks({ base: 4, isDotted: false, isTriplet: false })).toBe(960);
    expect(entryTicks({ base: 8, isDotted: true, isTriplet: false })).toBe(720);
    expect(entryTicks({ base: 8, isDotted: false, isTriplet: true })).toBe(320);
  });

  it('a typed letter takes the key signature and the octave nearest the last note', () => {
    const inG = { root: 7, scale: 'major' };
    expect(keyForLetter('f', 0, inG, 66)).toBe(66);
    expect(keyForLetter('f', 0, undefined, 66)).toBe(65);
    expect(keyForLetter('c', 0, undefined, 71)).toBe(72);
    expect(keyForLetter('b', -1, undefined, 70)).toBe(70);
    expect(keyForLetter('x', 0, undefined, 60)).toBeNull();
  });
});
