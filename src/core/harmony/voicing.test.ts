import { describe, expect, it } from 'vitest';
import { chordPitchClasses, formatChord, mod12, parseChord, type ChordSymbol } from './chord';
import { compNotes, naiveVoicing, totalMovement, voiceChords, voiceMovement, voicingCandidates } from './voicing';

const prog = (text: string): ChordSymbol[] => text.split(' ').map((t) => parseChord(t)!);

describe('voice leading', () => {
  it('moves far less than stacking every chord from its root', () => {
    for (const text of ['C Am F G', 'Am F C G', 'Dm7 G7 Cmaj7 Am7', 'Em C G D', 'Cm Ab Eb Bb']) {
      const chords = prog(text);
      const led = voiceChords(chords);
      const naive = chords.map((c) => naiveVoicing(c));
      expect(totalMovement(led), text).toBeLessThan(totalMovement(naive));
      expect(totalMovement(led), text).toBeLessThanOrEqual(10);
    }
  });

  it('keeps every chord complete, ascending and near the centre', () => {
    const chords = prog('Am7 Dm7 G7 Cmaj7 F/C Bdim');
    const led = voiceChords(chords, { center: 62 });
    led.forEach((keys, i) => {
      const want = new Set(chordPitchClasses(chords[i]!));
      expect(new Set(keys.map(mod12))).toEqual(want);
      expect([...keys].sort((a, b) => a - b)).toEqual(keys);
      const mean = keys.reduce((a, b) => a + b, 0) / keys.length;
      expect(Math.abs(mean - 62), formatChord(chords[i]!)).toBeLessThanOrEqual(11);
    });
  });

  it('is the best of all the candidates (checked by brute force)', () => {
    const chords = prog('C Am F G');
    const sets = chords.map((c) => voicingCandidates(c).map((x) => x.keys));
    let best = Infinity;
    const walk = (i: number, path: number[][]) => {
      if (i === sets.length) {
        best = Math.min(best, totalMovement(path));
        return;
      }
      for (const cand of sets[i]!) walk(i + 1, [...path, cand]);
    };
    walk(0, []);
    expect(totalMovement(voiceChords(chords))).toBe(best);
  });

  it('shares the notes two chords have in common', () => {
    const [a, b] = voiceChords(prog('C Am'));
    // C-E-G to A-C-E: C and E stay, G moves two steps.
    expect(voiceMovement(a!, b!)).toBeLessThanOrEqual(3);
  });

  it('honours the register, the spread, the first inversion and the bass', () => {
    const chords = prog('C F G C');
    const low = voiceChords(chords, { center: 48 });
    const high = voiceChords(chords, { center: 72 });
    expect(Math.max(...low.flat())).toBeLessThan(Math.min(...high.flat()) + 14);
    expect(low[0]![0]).toBeLessThan(high[0]![0]!);
    const open = voiceChords(chords, { spread: 'open' });
    expect(open[0]!.at(-1)! - open[0]![0]!).toBeGreaterThan(voiceChords(chords)[0]!.at(-1)! - voiceChords(chords)[0]![0]!);
    const first = voiceChords(chords, { inversion: 1 });
    expect(mod12(first[0]![0]!)).toBe(4);
    const withBass = voiceChords(prog('C/E F'), { bass: true, bassLow: 36 });
    expect(withBass[0]![0]).toBe(40);
    expect(withBass[1]![0]).toBe(41);
    expect(withBass[0]!.slice(1).every((k) => k > 50)).toBe(true);
  });

  it('puts a slash chord’s own bass lowest when no separate bass is added', () => {
    const [keys] = voiceChords(prog('F/C'));
    expect(mod12(keys![0]!)).toBe(0);
  });

  it('turns the voicings into notes by rhythm, restarting at each chord', () => {
    const bar = 3840;
    const beat = 960;
    const chords = [
      { tick: 0, length: bar },
      { tick: bar, length: bar / 2 },
    ];
    const voicings = [[60, 64, 67], [60, 65, 69]];
    const hold = compNotes(chords, voicings, { rhythm: 'hold', beat });
    expect(hold.map((n) => [n.tick, n.length])).toEqual([[0, bar], [0, bar], [0, bar], [bar, bar / 2], [bar, bar / 2], [bar, bar / 2]]);
    const beats = compNotes(chords, voicings, { rhythm: 'beats', beat });
    expect(beats).toHaveLength(3 * 4 + 3 * 2);
    expect(Math.max(...beats.filter((n) => n.tick < bar).map((n) => n.tick))).toBe(3 * beat);
    const off = compNotes(chords, voicings, { rhythm: 'offbeats', beat });
    expect(off.filter((n) => n.tick < bar && n.key === 60).map((n) => n.tick)).toEqual([480, 1440, 2400, 3360]);
    const eighths = compNotes(chords, voicings, { rhythm: 'eighths', beat });
    expect(eighths.filter((n) => n.key === 60 && n.tick < bar)).toHaveLength(8);
  });
});
