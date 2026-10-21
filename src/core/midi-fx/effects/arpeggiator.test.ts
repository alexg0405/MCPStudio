import { describe, expect, it } from 'vitest';
import { PPQ } from '../../time/ppq';
import { keysOf, noteAt, runOne, STEP, stepsOf } from '../test-support';

const C = 60;
const E = 64;
const G = 67;
/** A C major chord held for one bar. */
const chordHeldOneBar = [noteAt('c', 0, 16, C), noteAt('e', 0, 16, E), noteAt('g', 0, 16, G)];

describe('arpeggiator: the order of the notes', () => {
  it('up plays the held notes from the lowest and starts over, one every 1/16', () => {
    const out = runOne('arp', { pattern: 'up' }, chordHeldOneBar);
    expect(keysOf(out.slice(0, 7))).toEqual([C, E, G, C, E, G, C]);
    expect(stepsOf(out.slice(0, 7))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out).toHaveLength(16);
  });

  it('down plays from the highest', () => {
    expect(keysOf(runOne('arp', { pattern: 'down' }, chordHeldOneBar).slice(0, 6))).toEqual([G, E, C, G, E, C]);
  });

  it('up and down turns round without playing the end notes twice', () => {
    expect(keysOf(runOne('arp', { pattern: 'upDown' }, chordHeldOneBar).slice(0, 9))).toEqual([C, E, G, E, C, E, G, E, C]);
  });

  it('as played follows the order the keys went down, not their pitch', () => {
    const played = [noteAt('hi', 0, 16, G), noteAt('lo', 0.25, 15.75, C), noteAt('mid', 0.5, 15.5, E)];
    expect(keysOf(runOne('arp', { pattern: 'played' }, played).slice(0, 4))).toEqual([G, C, E, G]);
  });

  it('chord plays all the held notes together on every step', () => {
    const out = runOne('arp', { pattern: 'chord', rate: '1/4' }, chordHeldOneBar);
    expect(stepsOf(out)).toEqual([0, 0, 0, 4, 4, 4, 8, 8, 8, 12, 12, 12]);
  });

  it('octaves climb through every octave before starting over', () => {
    const out = runOne('arp', { pattern: 'up', octaves: 2 }, chordHeldOneBar);
    expect(keysOf(out.slice(0, 7))).toEqual([C, E, G, C + 12, E + 12, G + 12, C]);
  });

  it('random is the same every time for a seed and changes with the seed', () => {
    const first = keysOf(runOne('arp', { pattern: 'random', seed: 3 }, chordHeldOneBar));
    expect(keysOf(runOne('arp', { pattern: 'random', seed: 3 }, chordHeldOneBar))).toEqual(first);
    expect(keysOf(runOne('arp', { pattern: 'random', seed: 4 }, chordHeldOneBar))).not.toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
});

describe('arpeggiator: time', () => {
  it('rates are exact numbers of ticks, triplets and dotted notes included', () => {
    const at = (rate: string) => runOne('arp', { rate }, chordHeldOneBar, { from: 0, to: PPQ }).map((note) => note.start);
    expect(at('1/4')).toEqual([0]);
    expect(at('1/8')).toEqual([0, 480]);
    expect(at('1/16t')).toEqual([0, 160, 320, 480, 640, 800]);
    expect(at('1/32')).toHaveLength(8);
    expect(at('1/8.')).toEqual([0, 720]);
  });

  it('gate sets the length of each note as a share of the step', () => {
    const out = runOne('arp', { gate: 0.5 }, chordHeldOneBar);
    expect(out[0]!.end - out[0]!.start).toBe(STEP / 2);
    const long = runOne('arp', { gate: 1.5 }, chordHeldOneBar);
    expect(long[0]!.end - long[0]!.start).toBe(STEP * 1.5);
  });

  it('swing plays every second step late, up to half a step', () => {
    const out = runOne('arp', { swing: 1 }, chordHeldOneBar);
    expect(stepsOf(out.slice(0, 4))).toEqual([0, 1.5, 2, 3.5]);
  });

  it('starts on the key press, or waits for the next step of the song grid', () => {
    const late = [noteAt('c', 0.5, 4, C)];
    expect(stepsOf(runOne('arp', { sync: 'key' }, late).slice(0, 2))).toEqual([0.5, 1.5]);
    expect(stepsOf(runOne('arp', { sync: 'song' }, late).slice(0, 2))).toEqual([1, 2]);
  });

  it('a key tapped between two steps of the song grid still plays once', () => {
    const tap = [noteAt('c', 0.25, 0.25, C)];
    expect(stepsOf(runOne('arp', { sync: 'song' }, tap))).toEqual([1]);
    expect(stepsOf(runOne('arp', { sync: 'key' }, tap))).toEqual([0.25]);
  });

  it('stops when the notes end and starts a new arpeggio for the next chord', () => {
    const two = [noteAt('a', 0, 2, C), noteAt('b', 4, 2, E)];
    expect(stepsOf(runOne('arp', {}, two))).toEqual([0, 1, 4, 5]);
    expect(keysOf(runOne('arp', {}, two))).toEqual([C, C, E, E]);
  });

  it('is the same whichever stretch of the song is asked for, so a replan keeps it in phase', () => {
    const whole = runOne('arp', { pattern: 'random', octaves: 2, swing: 0.4 }, chordHeldOneBar);
    const pieces = [
      { from: 0, to: 1000 },
      { from: 1000, to: 2300 },
      { from: 2300, to: 2301 },
      { from: 2301, to: 4 * PPQ },
    ].flatMap((span) => runOne('arp', { pattern: 'random', octaves: 2, swing: 0.4 }, chordHeldOneBar, span));
    expect(pieces.map((n) => [n.id, n.start, n.key])).toEqual(whole.map((n) => [n.id, n.start, n.key]));
  });
});

describe('arpeggiator: velocity', () => {
  it('plays at the held notes’ velocity, a fixed level, or accents every Nth step', () => {
    const held = [noteAt('c', 0, 16, C, 0.6), noteAt('e', 0, 16, E, 0.6)];
    expect(runOne('arp', {}, held)[0]!.velocity).toBeCloseTo(0.6);
    expect(runOne('arp', { velocity: 'fixed', level: 0.3 }, held)[1]!.velocity).toBeCloseTo(0.3);
    const accented = runOne('arp', { velocity: 'accent', accentEvery: 2, accentDepth: 0.5 }, held);
    expect(accented.slice(0, 4).map((n) => +n.velocity.toFixed(2))).toEqual([0.6, 0.3, 0.6, 0.3]);
  });
});

describe('arpeggiator: latch and live keys', () => {
  it('latch keeps the chord going after the keys are released, until a new chord is played', () => {
    const played = [noteAt('c', 0, 1, C), noteAt('e', 0, 1, E), noteAt('g', 4, 1, G)];
    const out = runOne('arp', { latch: true }, played, { from: 0, to: 8 * STEP });
    expect(keysOf(out)).toEqual([C, E, C, E, G, G, G, G]);
    expect(stepsOf(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a key still held (no end yet) keeps arpeggiating up to the end of the span asked for', () => {
    const held = [{ ...noteAt('c', 0, 1, C), end: Infinity }, { ...noteAt('e', 0, 1, E), end: Infinity }];
    const out = runOne('arp', {}, held, { from: 0, to: 4 * STEP });
    expect(keysOf(out)).toEqual([C, E, C, E]);
  });
});
