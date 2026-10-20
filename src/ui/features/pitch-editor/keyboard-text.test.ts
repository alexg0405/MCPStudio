import { describe, expect, it } from 'vitest';
import type { DrawNote } from './model';
import { noteSentence, spokenPitch, spokenTime } from './keyboard-text';

function note(init: Partial<DrawNote>): DrawNote {
  return { index: 0, fromMs: 1200, toMs: 1900, sung: 60, target: 60, edited: false, drift: 0, vibrato: 1, ...init };
}

describe('spokenTime', () => {
  it('says seconds, then minutes and seconds', () => {
    expect(spokenTime(3200)).toBe('3.2 seconds');
    expect(spokenTime(65_000)).toBe('1 minute 5.0 seconds');
    expect(spokenTime(-5)).toBe('0.0 seconds');
  });
});

describe('spokenPitch', () => {
  it('names the note and says the cents when it is off', () => {
    expect(spokenPitch(60)).toBe('C5');
    expect(spokenPitch(61.004)).toBe('C sharp 5');
    expect(spokenPitch(60.3)).toBe('C5 plus 30 cents');
    expect(spokenPitch(63.65)).toBe('E5 minus 35 cents');
    expect(spokenPitch(60.004)).toBe('C5');
    expect(spokenPitch(60.01)).toBe('C5 plus 1 cent');
  });
});

describe('noteSentence', () => {
  it('says which note it is, how high, when, how long, and whether it is selected', () => {
    expect(noteSentence(note({ index: 2 }), 5, { isSelected: true })).toBe('Note 3 of 5, C5, at 1.2 seconds, 0.7 seconds long, selected');
  });

  it('says what was retuned and the word sung on it', () => {
    const retuned = note({ sung: 60, target: 62, edited: true });
    expect(noteSentence(retuned, 2, { isSelected: false, word: 'hello' })).toBe(
      'Note 1 of 2, D5, at 1.2 seconds, 0.7 seconds long, retuned from C5, word hello',
    );
  });
});
