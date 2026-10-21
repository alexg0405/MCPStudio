/** What each of the simpler MIDI effects does to fixed notes. (The arpeggiator has its own file.) */
import { describe, expect, it } from 'vitest';
import { PPQ } from '../../time/ppq';
import { keysOf, noteAt, runOne, STEP, testContext } from '../test-support';

const C = 60;
const E = 64;
const G = 67;

describe('chord', () => {
  const single = [noteAt('n', 0, 4, C)];

  it('builds a named shape on each note', () => {
    expect(keysOf(runOne('chord', { source: 'shape', shape: 'min' }, single))).toEqual([60, 63, 67]);
    expect(keysOf(runOne('chord', { source: 'shape', shape: 'maj7' }, single))).toEqual([60, 64, 67, 71]);
    expect(keysOf(runOne('chord', { source: 'shape', shape: '5' }, single))).toEqual([60, 67]);
  });

  it('every chord note starts and ends with the played note and keeps its pan and release', () => {
    const played = [{ ...noteAt('n', 2, 4, C), pan: -0.5, release: 0.2, fine: 10 }];
    const out = runOne('chord', { shape: 'maj' }, played);
    for (const note of out) {
      expect([note.start, note.end, note.pan, note.release, note.fine]).toEqual([2 * STEP, 6 * STEP, -0.5, 0.2, 10]);
    }
  });

  it('adds the intervals you choose (0 means none)', () => {
    expect(keysOf(runOne('chord', { source: 'intervals', add1: 7, add2: 12, add3: 0 }, single))).toEqual([60, 67, 72]);
    expect(keysOf(runOne('chord', { source: 'intervals', add1: -12, add2: 0, add3: 0 }, single))).toEqual([48, 60]);
  });

  it('inverts and spreads the chord', () => {
    expect(keysOf(runOne('chord', { shape: 'maj', inversion: 1 }, single))).toEqual([64, 67, 72]);
    expect(keysOf(runOne('chord', { shape: 'maj', inversion: 2 }, single))).toEqual([67, 72, 76]);
    expect(keysOf(runOne('chord', { shape: 'maj', spread: 'open' }, single))).toEqual([60, 67, 76]);
    expect(keysOf(runOne('chord', { shape: 'maj7', spread: 'drop2' }, single))).toEqual([55, 60, 64, 71]);
  });

  it('stacks thirds in the song key, starting on the played degree', () => {
    const inCMajor = testContext({ key: { root: 0, scale: 'major' } });
    // D in C major gives D minor (D F A); a seventh chord adds C.
    const d = [noteAt('n', 0, 4, 62)];
    expect(keysOf(runOne('chord', { source: 'scale', size: 3 }, d, undefined, inCMajor))).toEqual([62, 65, 69]);
    expect(keysOf(runOne('chord', { source: 'scale', size: 4 }, d, undefined, inCMajor))).toEqual([62, 65, 69, 72]);
    // A note outside the key is first moved into it.
    expect(keysOf(runOne('chord', { source: 'scale', size: 3 }, [noteAt('n', 0, 4, 61)], undefined, inCMajor))).toEqual([60, 64, 67]);
  });

  it('follows the chord track: the chord of the moment, voiced around the played key', () => {
    const context = testContext({ chords: [{ from: 0, chord: { root: 9, quality: 'min' } }, { from: 4 * STEP, chord: { root: 7, quality: 'maj' } }] });
    const played = [noteAt('a', 0, 2, 60), noteAt('b', 4, 2, 60)];
    const out = runOne('chord', { source: 'chordTrack' }, played, undefined, context);
    // A minor from its root nearest the played key, then G major from G3.
    expect(keysOf(out)).toEqual([57, 60, 64, 55, 59, 62]);
  });

  it('leaves a note alone where the chord track has no chord', () => {
    expect(keysOf(runOne('chord', { source: 'chordTrack' }, single))).toEqual([60]);
  });
});

describe('scale', () => {
  const inCMajor = testContext({ key: { root: 0, scale: 'major' } });

  it('moves notes outside the song key to the nearest note of it (a tie goes down)', () => {
    const out = runOne('scale', { source: 'song' }, [noteAt('a', 0, 1, 61), noteAt('b', 1, 1, 63), noteAt('c', 2, 1, 64)], undefined, inCMajor);
    expect(keysOf(out)).toEqual([60, 62, 64]);
  });

  it('can move notes up or down only', () => {
    const notes = [noteAt('a', 0, 1, 61)];
    expect(keysOf(runOne('scale', { direction: 'up' }, notes, undefined, inCMajor))).toEqual([62]);
    expect(keysOf(runOne('scale', { direction: 'down' }, notes, undefined, inCMajor))).toEqual([60]);
  });

  it('can drop notes outside the scale instead', () => {
    const out = runOne('scale', { mode: 'filter' }, [noteAt('a', 0, 1, 61), noteAt('b', 1, 1, 62)], undefined, inCMajor);
    expect(keysOf(out)).toEqual([62]);
  });

  it('lets everything through when there is no song key', () => {
    expect(keysOf(runOne('scale', {}, [noteAt('a', 0, 1, 61)]))).toEqual([61]);
  });

  it('follows the chord track: only the chord’s notes are allowed', () => {
    const context = testContext({ chords: [{ from: 0, chord: { root: 0, quality: 'maj' } }] });
    const out = runOne('scale', { source: 'chordTrack' }, [noteAt('a', 0, 1, 61), noteAt('b', 1, 1, 66)], undefined, context);
    expect(keysOf(out)).toEqual([60, 67]);
  });

  it('can use a scale you pick', () => {
    const out = runOne('scale', { source: 'custom', root: 'A', scale: 'minor-pentatonic' }, [noteAt('a', 0, 1, 61)]);
    expect(keysOf(out)).toEqual([60]);
  });
});

describe('note repeat', () => {
  it('rolls a note at the rate for as long as it lasts', () => {
    const out = runOne('repeat', { rate: '1/32', gate: 1 }, [noteAt('n', 0, 2, C)]);
    expect(out.map((n) => n.start)).toEqual([0, 120, 240, 360]);
    expect(out[0]!.end - out[0]!.start).toBe(120);
  });

  it('a fixed number of hits can run past the note', () => {
    expect(runOne('repeat', { rate: '1/16', count: 3 }, [noteAt('n', 0, 1, C)])).toHaveLength(3);
  });

  it('the ramp makes the roll build up or fade out', () => {
    const up = runOne('repeat', { rate: '1/16', ramp: 0.5 }, [noteAt('n', 0, 4, C, 0.4)]);
    expect(up.map((n) => +n.velocity.toFixed(2))).toEqual([0.4, 0.47, 0.53, 0.6]);
    const down = runOne('repeat', { rate: '1/16', ramp: -0.5 }, [noteAt('n', 0, 4, C, 0.8)]);
    expect(down[3]!.velocity).toBeCloseTo(0.4);
  });
});

describe('humanize', () => {
  const part = [0, 1, 2, 3, 4, 5, 6, 7].map((step) => noteAt(`n${step}`, step, 1, C, 0.7));

  it('moves notes by less than the timing amount and keeps their length', () => {
    const out = runOne('humanize', { timing: 10, velocity: 0 }, part);
    const maxTicks = 10 / 1000 / (60 / (120 * PPQ));
    for (const [i, note] of out.entries()) {
      expect(Math.abs(note.start - i * STEP)).toBeLessThanOrEqual(maxTicks + 1e-9);
      expect(note.end - note.start).toBeCloseTo(STEP);
    }
    expect(out.some((note, i) => note.start !== i * STEP)).toBe(true);
  });

  it('gives the same result every time, and another one for another seed', () => {
    const first = runOne('humanize', { seed: 5 }, part).map((n) => n.start);
    expect(runOne('humanize', { seed: 5 }, part).map((n) => n.start)).toEqual(first);
    expect(runOne('humanize', { seed: 6 }, part).map((n) => n.start)).not.toEqual(first);
  });

  it('a note keeps its draw when other notes change', () => {
    const alone = runOne('humanize', { seed: 2 }, [part[3]!]);
    const together = runOne('humanize', { seed: 2 }, part);
    expect(together.find((n) => n.id === 'n3')).toEqual(alone[0]);
  });

  it('live keys are only ever delayed', () => {
    const live = testContext({ live: true });
    const out = runOne('humanize', { timing: 20, velocity: 0 }, part, { from: -1000, to: 5000 }, live);
    for (const [i, note] of out.entries()) expect(note.start).toBeGreaterThanOrEqual(i * STEP);
  });

  it('keeps velocities between the quietest allowed and full', () => {
    const out = runOne('humanize', { velocity: 1 }, part);
    for (const note of out) expect(note.velocity).toBeGreaterThan(0);
    for (const note of out) expect(note.velocity).toBeLessThanOrEqual(1);
  });
});

describe('velocity', () => {
  const soft = [noteAt('n', 0, 1, C, 0.25)];
  const hard = [noteAt('n', 0, 1, C, 0.9)];

  it('compress makes soft notes louder and expand makes them softer', () => {
    expect(runOne('velocity', { curve: -1 }, soft)[0]!.velocity).toBeGreaterThan(0.25);
    expect(runOne('velocity', { curve: 1 }, soft)[0]!.velocity).toBeLessThan(0.25);
    expect(runOne('velocity', { curve: 0 }, soft)[0]!.velocity).toBeCloseTo(0.25);
  });

  it('a fixed level plays everything the same', () => {
    expect(runOne('velocity', { mode: 'fixed', fixed: 0.7 }, [...soft, ...hard]).map((n) => n.velocity)).toEqual([0.7, 0.7]);
  });

  it('a range squeezes the velocities between the lowest and the highest', () => {
    const out = runOne('velocity', { mode: 'range', low: 0.4, high: 0.6 }, [noteAt('a', 0, 1, C, 0), noteAt('b', 1, 1, C, 1)]);
    expect(out.map((n) => +n.velocity.toFixed(2))).toEqual([0.4, 0.6]);
  });
});

describe('transpose', () => {
  it('moves notes by semitones and octaves', () => {
    expect(keysOf(runOne('transpose', { semitones: 7 }, [noteAt('n', 0, 1, C)]))).toEqual([67]);
    expect(keysOf(runOne('transpose', { semitones: 2, octaves: -1 }, [noteAt('n', 0, 1, C)]))).toEqual([50]);
  });

  it('drops a note moved off the keyboard', () => {
    expect(runOne('transpose', { octaves: 4 }, [noteAt('n', 0, 1, 100), noteAt('m', 1, 1, 60)])).toHaveLength(1);
  });
});

describe('MIDI echo', () => {
  it('plays the note and then echoes a synced time apart, each quieter', () => {
    const out = runOne('echo', { delay: '1/8', repeats: 3, feedback: 0.5, decay: 1 }, [noteAt('n', 0, 1, C, 0.8)]);
    expect(out.map((n) => n.start)).toEqual([0, 480, 960, 1440]);
    expect(out.map((n) => +n.velocity.toFixed(2))).toEqual([0.8, 0.4, 0.2, 0.1]);
  });

  it('shifts the pitch of each echo and shortens it', () => {
    const out = runOne('echo', { delay: '1/8', repeats: 2, pitch: 2, decay: 0.5 }, [noteAt('n', 0, 2, C)]);
    expect(keysOf(out)).toEqual([60, 62, 64]);
    expect(out.map((n) => n.end - n.start)).toEqual([480, 240, 120]);
  });

  it('stops when the echoes are too quiet to hear and drops those off the keyboard', () => {
    expect(runOne('echo', { repeats: 16, feedback: 0.4 }, [noteAt('n', 0, 1, C, 0.5)], { from: 0, to: 20 * PPQ })).toHaveLength(4);
    expect(runOne('echo', { repeats: 3, pitch: 12 }, [noteAt('n', 0, 1, 100)])).toHaveLength(3);
  });
});

describe('note length', () => {
  it('fixed gives every note the same length', () => {
    const out = runOne('length', { mode: 'fixed', length: '1/8' }, [noteAt('a', 0, 1, C), noteAt('b', 4, 8, E)]);
    expect(out.map((n) => n.end - n.start)).toEqual([480, 480]);
  });

  it('scale makes notes a share of their length', () => {
    expect(runOne('length', { mode: 'scale', scale: 0.5 }, [noteAt('a', 0, 4, C)])[0]!.end).toBe(480);
  });

  it('legato holds each note until the next one starts, and a chord stays together', () => {
    const out = runOne('length', { mode: 'legato' }, [noteAt('a', 0, 1, C), noteAt('b', 0, 1, E), noteAt('c', 4, 1, G)]);
    expect(out.map((n) => n.end / STEP)).toEqual([4, 4, 5]);
  });
});

describe('random', () => {
  const part = Array.from({ length: 32 }, (_, step) => noteAt(`n${step}`, step, 1, C));
  const span = { from: 0, to: 32 * STEP };

  it('chance decides how many notes play, and the same notes play every time', () => {
    const half = runOne('random', { chance: 0.5, jump: 0 }, part, span);
    expect(half.length).toBeGreaterThan(8);
    expect(half.length).toBeLessThan(24);
    expect(runOne('random', { chance: 0.5, jump: 0 }, part, span).map((n) => n.id)).toEqual(half.map((n) => n.id));
    expect(runOne('random', { chance: 1, jump: 0 }, part, span)).toHaveLength(32);
    expect(runOne('random', { chance: 0 }, part, span)).toHaveLength(0);
  });

  it('octave jumps move notes by whole octaves within the range', () => {
    const out = runOne('random', { chance: 1, jump: 1, range: 2 }, part, span);
    const offsets = new Set(out.map((n) => n.key - C));
    for (const offset of offsets) expect([-24, -12, 12, 24]).toContain(offset);
    expect(offsets.size).toBeGreaterThan(1);
  });

  it('a note keeps its draw when other notes change', () => {
    const alone = runOne('random', { chance: 1, jump: 1 }, [part[5]!], span);
    const together = runOne('random', { chance: 1, jump: 1 }, part, span);
    expect(together.find((n) => n.id === 'n5')!.key).toBe(alone[0]!.key);
  });
});
