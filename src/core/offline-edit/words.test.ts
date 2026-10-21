/** Reading plain words: numbers, amounts, dB, tempo, key and the separate things a request asks for. */
import { describe, expect, it } from 'vitest';
import { amountOf, byAmount, decibelsIn, keyChangeIn, normalizeWords, splitClauses, tempoChangeIn } from './words';

describe('normalizeWords', () => {
  it('lowers case, plains quotes and dashes and drops the end punctuation', () => {
    expect(normalizeWords('  Busier   HATS in bars 9–16!  ')).toBe('busier hats in bars 9-16');
    expect(normalizeWords('Make it “louder”.')).toBe('make it “louder”');
    expect(normalizeWords('drums & bass')).toBe('drums and bass');
  });

  it('writes spelled-out counts as digits only where a count belongs', () => {
    expect(normalizeWords('the first eight bars')).toBe('the first 8 bars');
    expect(normalizeWords('eight bars of drums')).toBe('8 bars of drums');
    expect(normalizeWords('up two semitones')).toBe('up 2 semitones');
    expect(normalizeWords('turn it up three db')).toBe('turn it up 3 db');
    // "a" and "one" in other places stay words, so "a bit" survives.
    expect(normalizeWords('a bit louder')).toBe('a bit louder');
  });
});

describe('amounts', () => {
  it('reads "a bit" as small, "a lot" as large and nothing as medium', () => {
    expect(amountOf('a bit louder')).toBe('small');
    expect(amountOf('slightly busier')).toBe('small');
    expect(amountOf('much louder')).toBe('large');
    expect(amountOf('way busier')).toBe('large');
    expect(amountOf('louder')).toBe('medium');
  });

  it('picks a value by amount', () => {
    expect(byAmount('small', [1, 2, 3])).toBe(1);
    expect(byAmount('medium', [1, 2, 3])).toBe(2);
    expect(byAmount('large', [1, 2, 3])).toBe(3);
  });
});

describe('decibelsIn', () => {
  it('reads signed and unsigned levels', () => {
    expect(decibelsIn('+3 db')).toBe(3);
    expect(decibelsIn('-4 db')).toBe(-4);
    expect(decibelsIn('turn the lead up 3 db')).toBe(3);
    expect(decibelsIn('turn the lead down 3 db')).toBe(-3);
    expect(decibelsIn('2.5 decibels quieter')).toBe(-2.5);
    expect(decibelsIn('louder')).toBeNull();
  });
});

describe('splitClauses', () => {
  it('splits on commas, "then" and an "and" that starts a new request', () => {
    expect(splitClauses('busier hats, then a new melody for the chorus')).toEqual(['busier hats', 'a new melody for the chorus']);
    expect(splitClauses('busier hats and a new melody for the chorus')).toEqual(['busier hats', 'a new melody for the chorus']);
    expect(splitClauses('make the hats busier and turn the lead up 3 db')).toEqual(['make the hats busier', 'turn the lead up 3 db']);
  });

  it('keeps an "and" that joins two things of one request', () => {
    expect(splitClauses('remove the kick and snare in the chorus')).toEqual(['remove the kick and snare in the chorus']);
    expect(splitClauses('bars 9 and 10 simpler')).toEqual(['bars 9 and 10 simpler']);
  });
});

describe('tempoChangeIn', () => {
  it('reads a tempo named in the words', () => {
    expect(tempoChangeIn('tempo 128', 140, 'medium')?.bpm).toBe(128);
    expect(tempoChangeIn('set the bpm to 150', 140, 'medium')?.bpm).toBe(150);
    expect(tempoChangeIn('make it 120 bpm', 140, 'medium')?.bpm).toBe(120);
    expect(tempoChangeIn('slow it down to 90', 140, 'medium')?.bpm).toBe(90);
  });

  it('reads a feel and a direction', () => {
    expect(tempoChangeIn('double time', 70, 'medium')?.bpm).toBe(140);
    expect(tempoChangeIn('half time', 140, 'medium')?.bpm).toBe(70);
    expect(tempoChangeIn('faster', 100, 'medium')?.bpm).toBe(108);
    expect(tempoChangeIn('a bit slower', 100, 'small')?.bpm).toBe(96);
    expect(tempoChangeIn('a lot faster', 100, 'large')?.bpm).toBe(116);
    expect(tempoChangeIn('speed it up by 10 bpm', 100, 'medium')?.bpm).toBe(110);
  });

  it('keeps the tempo inside what the song settings accept', () => {
    expect(tempoChangeIn('double time', 200, 'medium')?.bpm).toBe(300);
    expect(tempoChangeIn('half time', 60, 'medium')?.bpm).toBe(40);
  });

  it('does not read a tempo into other words', () => {
    expect(tempoChangeIn('busier hats in bars 9-16', 140, 'medium')).toBeNull();
    expect(tempoChangeIn('add a riser', 140, 'medium')).toBeNull();
  });
});

describe('keyChangeIn', () => {
  it('reads a key named in the words', () => {
    expect(keyChangeIn('change the key to f minor')).toEqual({ kind: 'key', root: 5, minor: true });
    expect(keyChangeIn('move it to c# major')).toEqual({ kind: 'key', root: 1, minor: false });
    expect(keyChangeIn('put it in bb minor')).toEqual({ kind: 'key', root: 10, minor: true });
    expect(keyChangeIn('key of g')).toEqual({ kind: 'key', root: 7, minor: null });
  });

  it('reads a move by semitones or an interval', () => {
    expect(keyChangeIn('transpose up 2 semitones')).toEqual({ kind: 'shift', semitones: 2 });
    expect(keyChangeIn('down 3 semitones')).toEqual({ kind: 'shift', semitones: -3 });
    expect(keyChangeIn('transpose down a tone')).toEqual({ kind: 'shift', semitones: -2 });
    expect(keyChangeIn('up a fifth')).toEqual({ kind: 'shift', semitones: 7 });
    expect(keyChangeIn('transpose up an octave')).toEqual({ kind: 'shift', semitones: 12 });
  });

  it('does not read a key into other words', () => {
    expect(keyChangeIn('make it louder in a bit')).toBeNull();
    expect(keyChangeIn('busier hats')).toBeNull();
  });
});
