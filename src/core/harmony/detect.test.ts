import { describe, expect, it } from 'vitest';
import { mod12, parseChord, qualityOf, sameChord, type ChordSymbol } from './chord';
import { detectChordFromWeights, detectSpans, detectSpansFromChroma, type HarmonyNote } from './detect';

const BAR = 3840;

/** Seeded random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keys of a chord voiced with an inversion and some doubled upper notes, lowest first. */
function voicing(c: ChordSymbol, rand: () => number, inversion: number, base = 48): number[] {
  const q = qualityOf(c.quality);
  const keys = q.intervals.map((i) => base + mod12(c.root - base) + i);
  keys.sort((a, b) => a - b);
  for (let k = 0; k < inversion; k++) keys.push((keys.shift() as number) + 12);
  const spread = keys.map((k, i) => (i > 0 && rand() < 0.3 ? k + 12 : k)).sort((a, b) => a - b);
  return spread.filter((k, i) => spread.indexOf(k) === i);
}

const noteOf = (key: number, tick = 0, length = BAR): HarmonyNote => ({ tick, length, key, velocity: 0.8 });

describe('chord detection from weights', () => {
  it('reads plain chords and their inversions', () => {
    const cases: [number[], string][] = [
      [[60, 64, 67], 'C'],
      [[64, 67, 72], 'C/E'],
      [[67, 72, 76], 'C/G'],
      [[57, 60, 64], 'Am'],
      [[57, 60, 64, 67], 'Am7'],
      [[55, 59, 62, 65], 'G7'],
      [[60, 64, 67, 71], 'Cmaj7'],
      [[62, 65, 69, 72], 'Dm7'],
      [[59, 62, 65], 'Bdim'],
      [[60, 62, 67], 'Csus2'],
      [[60, 67], 'C5'],
    ];
    for (const [keys, want] of cases) {
      const w = new Float64Array(12);
      for (const k of keys) w[mod12(k)] = 1;
      const d = detectChordFromWeights(w, mod12(Math.min(...keys)));
      expect(d, want).not.toBeNull();
      expect(sameChord(d!.chord, parseChord(want)), `${want} read as ${JSON.stringify(d)}`).toBe(true);
    }
  });

  it('gives nothing for a single note or silence', () => {
    expect(detectChordFromWeights(new Float64Array(12))).toBeNull();
    const one = new Float64Array(12);
    one[3] = 5;
    expect(detectChordFromWeights(one, 3)).toBeNull();
  });

  it('is less sure of a smear of notes than of a clean chord', () => {
    const clean = new Float64Array(12);
    for (const k of [0, 4, 7]) clean[k] = 1;
    const smear = new Float64Array(12).fill(0.4);
    for (const k of [0, 4, 7]) smear[k] = 1;
    expect(detectChordFromWeights(clean, 0)!.confidence).toBeGreaterThan(detectChordFromWeights(smear, 0)!.confidence);
    expect(detectChordFromWeights(clean, 0)!.confidence).toBeGreaterThan(0.85);
  });
});

describe('detecting a chord track from notes', () => {
  it('finds a progression written as bars of held chords', () => {
    const prog = ['Am7', 'F', 'C', 'G'].map((t) => parseChord(t)!);
    const notes: HarmonyNote[] = [];
    prog.forEach((c, i) => {
      for (const k of voicing(c, rng(i), 0)) notes.push(noteOf(k, i * BAR));
    });
    const spans = detectSpans(notes, { bar: BAR });
    expect(spans.map((s) => s.tick / BAR)).toEqual([0, 1, 2, 3]);
    spans.forEach((s, i) => expect(sameChord(s.chord, prog[i]), `bar ${i + 1}`).toBe(true));
  });

  it('merges bars of the same chord and splits half bars when asked', () => {
    const am = parseChord('Am')!;
    const f = parseChord('F')!;
    const notes: HarmonyNote[] = [];
    for (const k of voicing(am, rng(1), 0)) notes.push(noteOf(k, 0, BAR * 2));
    for (const k of voicing(am, rng(2), 0)) notes.push(noteOf(k, BAR * 2, BAR / 2));
    for (const k of voicing(f, rng(3), 0)) notes.push(noteOf(k, BAR * 2 + BAR / 2, BAR / 2));
    const spans = detectSpans(notes, { bar: BAR, resolution: 'half' });
    expect(spans.map((s) => [s.tick, s.length])).toEqual([
      [0, BAR * 2 + BAR / 2],
      [BAR * 2 + BAR / 2, BAR / 2],
    ]);
    expect(sameChord(spans[1]!.chord, f)).toBe(true);
  });

  it('names the bass of a slash chord from the lowest note', () => {
    const notes = [noteOf(40), noteOf(60), noteOf(64), noteOf(67)];
    const [span] = detectSpans(notes, { bar: BAR });
    expect(span!.chord).toEqual({ root: 0, quality: 'maj', bass: 4 });
  });

  it('is at least 95% right on clean voicings, inversions included', () => {
    // Qualities whose inversions cannot be told from another chord of the list (C6 = Am7/C, Csus4 = Fsus2/C, Caug and
    // Cdim7 repeat every third / fourth semitone) are tested in root position only.
    const inverted = ['maj', 'min', 'dim', '7', 'maj7', 'm7', 'm7b5', 'mMaj7', '9', 'maj9', 'm9', 'add9', 'madd9'];
    const rootOnly = ['sus2', 'sus4', 'aug', 'dim7', '7sus4', '5'];
    const rand = rng(20240607);
    let total = 0;
    let right = 0;
    const misses: string[] = [];
    for (let n = 0; n < 1200; n++) {
      const useInv = rand() < 0.8;
      const pool = useInv ? inverted : rootOnly;
      const quality = pool[Math.floor(rand() * pool.length)] as string;
      const root = Math.floor(rand() * 12);
      const chord: ChordSymbol = { root, quality };
      const size = qualityOf(quality).intervals.length;
      const inversion = useInv ? Math.floor(rand() * Math.min(size, 4)) : 0;
      const keys = voicing(chord, rand, inversion, 40 + Math.floor(rand() * 20));
      // The inversion decides the bass: the slash chord is the right answer for an inverted chord.
      const bassPc = mod12(keys[0] as number);
      const want: ChordSymbol = { ...chord, ...(bassPc !== root ? { bass: bassPc } : {}) };
      const got = detectSpans(
        keys.map((k) => noteOf(k)),
        { bar: BAR },
      )[0];
      total++;
      if (got && sameChord(got.chord, want)) right++;
      else misses.push(`${JSON.stringify(want)} (${keys.join(',')}) -> ${got ? JSON.stringify(got.chord) : 'none'}`);
    }
    expect(total).toBeGreaterThan(1000);
    expect(right / total, misses.slice(0, 8).join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  it('reads chords from audio chroma', () => {
    const frame = (keys: number[]) => {
      const c = new Float64Array(12).fill(0.03);
      for (const k of keys) c[mod12(k)] = 1;
      return c;
    };
    const spans = detectSpansFromChroma([
      { tick: 0, length: BAR, chroma: frame([0, 4, 7]), bass: frame([0]) },
      { tick: BAR, length: BAR, chroma: frame([0, 4, 7]), bass: frame([0]) },
      { tick: BAR * 2, length: BAR, chroma: frame([9, 0, 4]), bass: frame([9]) },
      { tick: BAR * 3, length: BAR, chroma: new Float64Array(12).fill(0.5) },
    ]);
    expect(spans.map((s) => [s.tick / BAR, s.length / BAR])).toEqual([
      [0, 2],
      [2, 1],
    ]);
    expect(sameChord(spans[1]!.chord, parseChord('Am'))).toBe(true);
  });
});
