/**
 * Loops in the sample browser: tempo, bars and key on synthetic loops from the DJ tests' song renderer (drums with a bass and
 * chord pads, known tempo and key), and the one-shot / loop call on the whole one-shot corpus.
 */
import { describe, expect, it } from 'vitest';
import { chord, MAJOR, MINOR, PATTERNS, renderTestSong, type Chord, type DrumPattern, type SongPart } from '@core/dj/test-songs';
import { analyzeSample, findOnsets } from '@core/samples/analyze';
import { monoMix } from '@core/samples/features';
import { engineCorpus, handmadeCorpus } from '../helpers/sample-corpus';

const SR = 44100;

const STYLES: [string, DrumPattern, number, number][] = [
  ['house', PATTERNS.house, 124, 4],
  ['house', PATTERNS.house, 128, 2],
  ['boom bap', PATTERNS.boomBap, 90, 2],
  ['boom bap', PATTERNS.boomBap, 82, 4],
  ['trap', PATTERNS.trap, 140, 4],
  ['trap', PATTERNS.trap, 150, 2],
  ['drum and bass', PATTERNS.dnb, 174, 4],
  ['pop', PATTERNS.pop, 100, 2],
  ['pop', PATTERNS.pop, 110, 4],
  ['dembow', PATTERNS.dembow, 96, 4],
  ['house', PATTERNS.house, 120, 8],
  ['pop', PATTERNS.pop, 75, 2],
];
const PARTS: [string, (bars: number) => SongPart][] = [
  ['drums', (bars) => ({ bars, kick: true, snare: true, hats: true })],
  ['drums and bass', (bars) => ({ bars, kick: true, snare: true, hats: true, bass: true })],
  ['everything', (bars) => ({ bars, kick: true, snare: true, hats: true, bass: true, pads: true })],
];

describe('loop tempo and bars', () => {
  const cases = STYLES.flatMap(([style, pattern, bpm, bars]) =>
    PARTS.map(([what, part]) => ({ style, pattern, bpm, bars, what, part: part(bars) })),
  );

  it('reads the tempo and the number of bars of drum, bass and full loops', () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const song = renderTestSong({ sampleRate: SR, bpm: c.bpm, pattern: c.pattern, parts: [c.part], tail: 0, chords: [chord(57, MINOR), chord(53, MAJOR), chord(48, MAJOR), chord(55, MAJOR)] });
      const a = analyzeSample([song.mono], SR);
      const ok = a.kind === 'loop' && a.bpm !== undefined && Math.abs(a.bpm - c.bpm) <= 0.6 && a.bars === c.bars;
      if (!ok) wrong.push(`${c.style} ${c.bpm} BPM ${c.bars} bars (${c.what}): ${a.kind} ${a.bpm} BPM ${a.bars} bars`);
    }
    // A pulse that is not there (a pad on its own) is not forced to a tempo.
    expect(1 - wrong.length / cases.length, wrong.join('\n')).toBeGreaterThanOrEqual(0.9);
  });

  it('does not invent a tempo for chords with no pulse, or a loop for a single note', () => {
    const pads = renderTestSong({ sampleRate: SR, bpm: 100, pattern: PATTERNS.pop, parts: [{ bars: 4, pads: true }], tail: 0 });
    const a = analyzeSample([pads.mono], SR);
    expect(a.kind === 'loop' ? a.bpm : undefined).toBeUndefined();
  });

  it('takes the tempo from the file name when it says one that fits, and the length decides halves and doubles', () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 174, pattern: PATTERNS.dnb, parts: [{ bars: 4, kick: true, snare: true, hats: true }], tail: 0 });
    const named = analyzeSample([song.mono], SR, { path: 'Loops/DnB Loop 174 BPM.wav' });
    expect(named.kind).toBe('loop');
    expect(named.bpm).toBeCloseTo(174, 0);
    expect(named.bars).toBe(4);
    // The name says 87 (half time): same tempo family, so the name's number is used.
    const half = analyzeSample([song.mono], SR, { path: 'Loops/Break 87bpm.wav' });
    expect(half.bpm).toBeCloseTo(87, 0);
  });
});

/** A four-bar loop in a key: tonic, subdominant, dominant, tonic chords (bass on the roots, pads on top). */
function loopInKey(tonic = 48, minor = false, bpm = 110) {
  const triad = minor ? MINOR : MAJOR;
  const chords: Chord[] = [chord(tonic, triad), chord(tonic + 5, triad), chord(tonic + 7, triad), chord(tonic, triad)];
  return renderTestSong({ sampleRate: SR, bpm, pattern: PATTERNS.pop, parts: [{ bars: 4, kick: true, snare: true, hats: true, bass: true, pads: true }], tail: 0, chords });
}

describe('loop key', () => {
  it('finds the key of chord loops: the tonic and major or minor, or the relative key (the same notes)', () => {
    let exact = 0;
    let relativeOk = 0;
    let n = 0;
    const wrong: string[] = [];
    for (const tonic of [48, 50, 51, 53, 54, 55, 57, 59]) {
      for (const minor of [false, true]) {
        const a = analyzeSample([loopInKey(tonic, minor).mono], SR);
        n++;
        const root = tonic % 12;
        const isExact = a.root === root && a.mode === (minor ? 'minor' : 'major');
        // The relative key shares the notes: C major = A minor.
        const relRoot = minor ? (root + 3) % 12 : (root + 9) % 12;
        const isRel = a.root === relRoot && a.mode === (minor ? 'major' : 'minor');
        if (isExact) exact++;
        if (isExact || isRel) relativeOk++;
        else wrong.push(`${root}${minor ? 'm' : ''}: read ${a.root} ${a.mode}`);
      }
    }
    expect(relativeOk / n, wrong.join('\n')).toBeGreaterThanOrEqual(0.8);
    expect(exact / n).toBeGreaterThanOrEqual(0.6);
  });

  it('mostly leaves the key out of a drum loop (a tuned kick is not a key) and calls it a drum loop', () => {
    let withKey = 0;
    let drums = 0;
    for (const [, pattern, bpm, bars] of STYLES.slice(0, 8)) {
      const song = renderTestSong({ sampleRate: SR, bpm, pattern, parts: [{ bars, kick: true, snare: true, hats: true }], tail: 0 });
      const a = analyzeSample([song.mono], SR);
      if (a.root !== undefined) withKey++;
      if (a.loopKind === 'drums') drums++;
    }
    expect(withKey).toBeLessThanOrEqual(2);
    expect(drums).toBeGreaterThanOrEqual(6);
  });

  it('calls a bass line a bass loop and chords a melodic loop', () => {
    const bass = renderTestSong({ sampleRate: SR, bpm: 128, pattern: { kick: [], snare: [], hat: [] }, parts: [{ bars: 4, bass: true }], tail: 0, bassHits: [0, 0.75, 1.5, 2, 3], chords: [chord(57, MINOR)] });
    const a = analyzeSample([bass.mono], SR, { path: 'bass loop.wav' });
    expect(a.kind).toBe('loop');
    expect(a.loopKind).toBe('bass');
    expect(a.root).toBe(9);
    // Chords over a beat (no bass line of its own).
    const keys = renderTestSong({ sampleRate: SR, bpm: 110, pattern: PATTERNS.pop, parts: [{ bars: 4, kick: true, snare: true, hats: true, pads: true }], tail: 0, chords: [chord(57, MINOR), chord(53, MAJOR), chord(48, MAJOR), chord(55, MAJOR)] });
    expect(analyzeSample([keys.mono], SR).loopKind).toBe('melodic');
  });
});

describe('one-shot or loop', () => {
  it('calls every one-shot in the corpus a one-shot, however long its tail, and every drum loop a loop', () => {
    const sounds = [...engineCorpus(), ...handmadeCorpus(10)];
    const loops = sounds.filter((s) => analyzeSample([s.x], SR).kind !== 'one-shot').map((s) => s.name);
    expect(loops).toEqual([]);
  });

  it('finds the hits of a loop (and none in a held note)', () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 120, pattern: PATTERNS.house, parts: [{ bars: 2, kick: true }], tail: 0 });
    const hits = findOnsets(monoMix([song.mono], SR), SR);
    // 4 kicks a bar, 2 bars; the first is at 0 (before the detector's 40 ms window).
    expect(hits.length).toBeGreaterThanOrEqual(6);
    expect(hits.length).toBeLessThanOrEqual(9);
    const note = handmadeCorpus(1).find((s) => s.name === '808 0')!;
    expect(findOnsets(note.x, SR)).toEqual([]);
  });

  it('marks a long file (a song) without reading it in depth', () => {
    const a = analyzeSample([new Float32Array(1000)], SR, { durationSec: 240 });
    expect(a.kind).toBe('long');
    expect(a.durationSec).toBe(240);
    expect(a.category).toBeNull();
  });

  it('trusts the name for a loop it cannot hear the grid of', () => {
    const pads = renderTestSong({ sampleRate: SR, bpm: 100, pattern: PATTERNS.pop, parts: [{ bars: 4, pads: true }], tail: 0, chords: [chord(57, MINOR), chord(53, MAJOR), chord(48, MAJOR), chord(55, MAJOR)] });
    expect(analyzeSample([pads.mono], SR).kind).toBe('one-shot');
    const named = analyzeSample([pads.mono], SR, { path: 'Chord Loop 100 bpm Am.wav' });
    expect(named.kind).toBe('loop');
    expect(named.bpm).toBe(100);
  });
});
