import { describe, expect, it } from 'vitest';
import { chromagram } from './chroma';
import { camelotOf, estimateKey, keyName } from './key';
import { MAJOR, MINOR, PATTERNS, chord, renderTestSong, type Chord } from './test-songs';

const SR = 22050;
const DIM = [0, 3, 6] as const;

function keyOf(chords: Chord[], opts: { drums?: boolean; tuningCents?: number } = {}) {
  const song = renderTestSong({
    sampleRate: SR,
    bpm: 110,
    pattern: PATTERNS.pop,
    parts: [{ bars: 8, pads: true, bass: true, kick: !!opts.drums, snare: !!opts.drums, hats: !!opts.drums }],
    chords,
    ...(opts.tuningCents ? { tuningCents: opts.tuningCents } : {}),
  });
  const c = chromagram(song.mono, SR);
  return { key: estimateKey(c), tuning: c.tuningCents };
}

/** I–IV–V–I in a major key rooted at MIDI `r` (C3 = 48 …). */
const majorCadence = (r: number) => [chord(r, MAJOR), chord(r + 5, MAJOR), chord(r + 7, MAJOR), chord(r, MAJOR)];
/** i–iv–V–i (harmonic minor: the major V). */
const minorCadence = (r: number) => [chord(r, MINOR), chord(r + 5, MINOR), chord(r + 7, MAJOR), chord(r, MINOR)];

describe('Camelot', () => {
  it('maps keys to the wheel', () => {
    expect(camelotOf(0, 'major')).toBe('8B');
    expect(camelotOf(9, 'minor')).toBe('8A');
    expect(camelotOf(7, 'major')).toBe('9B');
    expect(camelotOf(4, 'minor')).toBe('9A');
    expect(camelotOf(5, 'major')).toBe('7B');
    expect(camelotOf(5, 'minor')).toBe('4A');
    expect(camelotOf(11, 'major')).toBe('1B');
    expect(camelotOf(8, 'minor')).toBe('1A');
    expect(camelotOf(6, 'major')).toBe('2B');
    expect(camelotOf(3, 'minor')).toBe('2A');
    expect(keyName({ root: 3, mode: 'minor' })).toBe('E♭ minor');
  });
});

describe('key detection', () => {
  for (let pc = 0; pc < 12; pc++) {
    const r = 48 + pc;
    it(`finds ${keyName({ root: pc, mode: 'major' })} (I–IV–V–I)`, () => {
      const { key } = keyOf(majorCadence(r), { drums: pc % 3 === 0 });
      expect(key && keyName(key)).toBe(keyName({ root: pc, mode: 'major' }));
      expect(key!.confidence).toBeGreaterThan(0.3);
    });
    it(`finds ${keyName({ root: pc, mode: 'minor' })} (i–iv–V–i)`, () => {
      const { key } = keyOf(minorCadence(r), { drums: pc % 3 === 1 });
      expect(key && keyName(key)).toBe(keyName({ root: pc, mode: 'minor' }));
    });
  }

  it('finds a natural-minor loop (i–VI–VII–i in E minor) and a pop loop (I–vi–IV–V in G)', () => {
    expect(keyOf([chord(52, MINOR), chord(48, MAJOR), chord(50, MAJOR), chord(52, MINOR)]).key?.camelot).toBe('9A');
    expect(keyOf([chord(55, MAJOR), chord(52, MINOR), chord(48, MAJOR), chord(50, MAJOR)]).key?.camelot).toBe('9B');
  });

  it('finds the key of a detuned song and measures the tuning', () => {
    const { key, tuning } = keyOf(minorCadence(53), { tuningCents: 35 });
    expect(key && keyName(key)).toBe('F minor');
    expect(Math.abs(tuning - 35)).toBeLessThan(8);
  });

  it('finds ii–V–I with a diminished passing chord', () => {
    // D minor: i – ii° – V – i
    const { key } = keyOf([chord(50, MINOR), chord(52, DIM), chord(57, MAJOR), chord(50, MINOR)]);
    expect(key && keyName(key)).toBe('D minor');
  });

  it('says little about drums alone', () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 120, pattern: PATTERNS.house, parts: [{ bars: 8, kick: true, snare: true, hats: true }] });
    const key = estimateKey(chromagram(song.mono, SR));
    expect(key === null || key.confidence < 0.35).toBe(true);
  });
});
