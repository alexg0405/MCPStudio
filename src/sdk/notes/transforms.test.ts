import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ScriptNote } from '../types';
import {
  arpeggiate,
  chop,
  chordify,
  fitVelocities,
  flip,
  generate,
  glue,
  humanize,
  inScale,
  legato,
  limit,
  nearestGridLine,
  noteEnd,
  quantize,
  rampVelocities,
  randomize,
  scaleVelocities,
  seeded,
  snapNotesToScale,
  strum,
  stretch,
  transpose,
  transposeDegrees,
  type Rand,
} from './index';

const noteArb = (opts: { minKey?: number; maxKey?: number; maxTick?: number } = {}) =>
  fc.record({
    tick: fc.integer({ min: 0, max: opts.maxTick ?? 3840 * 4 }),
    length: fc.integer({ min: 1, max: 1920 }),
    key: fc.integer({ min: opts.minKey ?? 0, max: opts.maxKey ?? 127 }),
    velocity: fc.double({ min: 0, max: 1, noNaN: true }),
  });

/** Notes with ids n0, n1, … (as the host passes them). */
const notesArb = (opts: Parameters<typeof noteArb>[0] = {}, maxLength = 30) =>
  fc.array(noteArb(opts), { maxLength }).map((list) => list.map((n, i): ScriptNote => ({ ...n, id: `n${i}` })));

function freeze(notes: ScriptNote[]): readonly ScriptNote[] {
  for (const n of notes) Object.freeze(n);
  return Object.freeze(notes);
}

function expectValid(out: readonly ScriptNote[], inputIds: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const n of out) {
    expect(Number.isInteger(n.tick) && n.tick >= 0).toBe(true);
    expect(Number.isInteger(n.length) && n.length >= 1).toBe(true);
    expect(Number.isInteger(n.key) && n.key >= 0 && n.key <= 127).toBe(true);
    expect(n.velocity >= 0 && n.velocity <= 1).toBe(true);
    if (n.id !== undefined) {
      expect(inputIds.has(n.id)).toBe(true);
      expect(seen.has(n.id)).toBe(false);
      seen.add(n.id);
    }
  }
}

const key = { root: 9, scale: 'minor' };

const TRANSFORMS: [string, (notes: readonly ScriptNote[], rand: Rand) => ScriptNote[]][] = [
  ['quantize', (ns) => quantize(ns, { grid: 240, strength: 0.7, ends: true, swing: 0.3 })],
  ['quantize lengths', (ns) => quantize(ns, { grid: 160, lengths: true, window: 0.5 })],
  ['humanize', (ns, r) => humanize(ns, { rand: r, timing: 60, velocity: 0.2, length: 0.3 })],
  ['legato', (ns) => legato(ns, { gap: 10, until: 3840 * 5 })],
  ['chop grid', (ns) => chop(ns, { grid: 120 })],
  ['chop parts', (ns) => chop(ns, { parts: 3, gate: 0.5 })],
  ['glue', (ns) => glue(ns, { gap: 30 })],
  [
    'strum',
    (ns, r) => strum(ns, { time: 200, direction: 'random', curve: 0.5, velocity: -0.5, tolerance: 20, rand: r }),
  ],
  ['arpeggiate', (ns, r) => arpeggiate(ns, { rate: 120, gate: 0.5, octaves: 3, pattern: 'random', rand: r })],
  ['arpeggiate up-down', (ns) => arpeggiate(ns, { rate: 160, pattern: 'up-down', octaves: 2, range: 19 })],
  ['flip time', (ns) => flip(ns, 'time')],
  ['flip pitch', (ns) => flip(ns, 'pitch')],
  ['transpose', (ns) => transpose(ns, 30)],
  ['transpose degrees', (ns) => transposeDegrees(ns, -9, { root: 2, scale: 'dorian' })],
  ['snap to scale', (ns) => snapNotesToScale(ns, { root: 5, scale: 'blues' })],
  ['limit', (ns) => limit(ns, { low: 40, high: 70 })],
  ['chordify', (ns) => chordify(ns, { chord: 'm9', inversion: 2, voicing: 'spread' })],
  ['chordify diatonic', (ns) => chordify(ns, { chord: 'diatonic', size: 4, key })],
  ['scale velocities', (ns) => scaleVelocities(ns, { factor: 1.7, offset: -0.2 })],
  ['fit velocities', (ns) => fitVelocities(ns, { min: 0.9, max: 0.2 })],
  ['ramp velocities', (ns) => rampVelocities(ns, { from: 0.1, to: 1.4, curve: -0.4, multiply: true })],
  ['randomize', (ns, r) => randomize(ns, { rand: r, pitch: 7, velocity: 0.3, key })],
  ['stretch', (ns) => stretch(ns, { factor: 0.37 })],
];

describe('note transforms: shared guarantees', () => {
  it.each(TRANSFORMS)('%s returns valid notes, keeps ids unique and never mutates its input', (_name, fn) => {
    fc.assert(
      fc.property(notesArb(), fc.integer(), (notes, seed) => {
        const input = freeze(notes);
        const out = fn(input, seeded(seed));
        expectValid(out, new Set(notes.map((n) => n.id as string)));
        // Deterministic for a given random sequence.
        expect(fn(input, seeded(seed))).toEqual(out);
      }),
      { numRuns: 60 },
    );
  });
});

describe('quantize', () => {
  const grids = fc.constantFrom(60, 120, 160, 240, 320, 480, 960);

  it('at 100% lands on the grid and is idempotent', () => {
    fc.assert(
      fc.property(notesArb(), grids, fc.boolean(), fc.boolean(), (notes, grid, ends, lengths) => {
        const once = quantize(notes, { grid, ends, lengths });
        for (const n of once) expect(n.tick % grid).toBe(0);
        if (ends) for (const n of once) expect(noteEnd(n) % grid).toBe(0);
        if (lengths && !ends) for (const n of once) expect(n.length % grid).toBe(0);
        expect(quantize(once, { grid, ends, lengths })).toEqual(once);
      }),
    );
  });

  it('with swing lands on swung lines and is idempotent', () => {
    fc.assert(
      fc.property(notesArb(), grids, fc.double({ min: 0, max: 1, noNaN: true }), (notes, grid, swing) => {
        const once = quantize(notes, { grid, swing });
        for (const n of once) expect(n.tick).toBe(Math.round(nearestGridLine(n.tick, grid, swing)));
        expect(quantize(once, { grid, swing })).toEqual(once);
      }),
    );
    // Swing 50%: the second 1/16 of each pair lands a quarter step late.
    expect(quantize([{ tick: 250, length: 10, key: 60, velocity: 1 }], { grid: 240, swing: 0.5 })[0]?.tick).toBe(300);
  });

  it('partial strength moves notes part of the way; 0% changes nothing', () => {
    const n: ScriptNote = { id: 'a', tick: 100, length: 50, key: 60, velocity: 0.5 };
    expect(quantize([n], { grid: 240, strength: 0.5 })[0]?.tick).toBe(50);
    fc.assert(
      fc.property(notesArb(), grids, (notes, grid) => {
        expect(quantize(notes, { grid, strength: 0 })).toEqual(notes);
      }),
    );
  });

  it('keeps notes outside the window where they are', () => {
    const notes: ScriptNote[] = [
      { tick: 10, length: 10, key: 60, velocity: 1 },
      { tick: 100, length: 10, key: 60, velocity: 1 },
    ];
    expect(quantize(notes, { grid: 240, window: 0.25 }).map((n) => n.tick)).toEqual([0, 100]);
  });
});

describe('humanize', () => {
  it('stays within its amounts and does nothing at zero', () => {
    fc.assert(
      fc.property(notesArb(), fc.integer(), fc.integer({ min: 0, max: 100 }), (notes, seed, timing) => {
        const out = humanize(notes, { rand: seeded(seed), timing, velocity: 0.1 });
        out.forEach((n, i) => {
          const src = notes[i] as ScriptNote;
          expect(Math.abs(n.tick - src.tick)).toBeLessThanOrEqual(timing);
          expect(Math.abs(n.velocity - src.velocity)).toBeLessThanOrEqual(0.1 + 1e-9);
          expect(n.length).toBe(src.length);
        });
        expect(humanize(notes, { rand: seeded(seed) })).toEqual(notes);
      }),
    );
  });
});

describe('legato', () => {
  it('leaves no gaps or overlaps on a line', () => {
    const line = fc
      .uniqueArray(fc.integer({ min: 0, max: 20000 }), { minLength: 1, maxLength: 30 })
      .chain((ticks) =>
        fc.tuple(
          fc.constant(ticks),
          fc.array(fc.integer({ min: 1, max: 4000 }), { minLength: ticks.length, maxLength: ticks.length }),
        ),
      )
      .map(([ticks, lengths]) =>
        ticks.map((tick, i): ScriptNote => ({ id: `n${i}`, tick, length: lengths[i] as number, key: 60, velocity: 1 })),
      );
    fc.assert(
      fc.property(line, (notes) => {
        const out = legato(notes).sort((a, b) => a.tick - b.tick);
        for (let i = 0; i + 1 < out.length; i++) expect(noteEnd(out[i]!)).toBe(out[i + 1]!.tick);
        const last = out[out.length - 1]!;
        expect(last.length).toBe(notes.find((n) => n.id === last.id)!.length);
      }),
    );
  });

  it('ends chords together at the next start', () => {
    const out = legato([
      { id: 'a', tick: 0, length: 100, key: 60, velocity: 1 },
      { id: 'b', tick: 0, length: 5000, key: 64, velocity: 1 },
      { id: 'c', tick: 960, length: 10, key: 62, velocity: 1 },
    ]);
    expect(out.map((n) => n.length)).toEqual([960, 960, 10]);
  });
});

describe('chop and glue', () => {
  it('chop covers each note exactly with contiguous pieces', () => {
    fc.assert(
      fc.property(
        noteArb(),
        fc.oneof(
          fc.record({ grid: fc.integer({ min: 1, max: 960 }) }),
          fc.record({ parts: fc.integer({ min: 1, max: 16 }) }),
        ),
        (raw, how) => {
          const n: ScriptNote = { ...raw, id: 'x' };
          const pieces = chop([n], how).sort((a, b) => a.tick - b.tick);
          expect(pieces[0]?.tick).toBe(n.tick);
          expect(pieces[0]?.id).toBe('x');
          expect(pieces.slice(1).every((p) => p.id === undefined)).toBe(true);
          for (let i = 0; i + 1 < pieces.length; i++) expect(noteEnd(pieces[i]!)).toBe(pieces[i + 1]!.tick);
          expect(noteEnd(pieces[pieces.length - 1]!)).toBe(noteEnd(n));
          expect(pieces.reduce((s, p) => s + p.length, 0)).toBe(n.length);
          if ('grid' in how) for (const p of pieces.slice(1)) expect(p.tick % how.grid).toBe(0);
          else expect(pieces.length).toBe(Math.min(how.parts, n.length));
        },
      ),
    );
  });

  it('glue merges touching same-key notes and keeps what they cover', () => {
    const cover = (notes: readonly ScriptNote[]) => {
      const cells = new Set<string>();
      for (const n of notes) for (let t = n.tick; t < noteEnd(n); t += 10) cells.add(`${n.key}:${t}`);
      return cells;
    };
    const arb = notesArb({ minKey: 60, maxKey: 62 }, 20).map((ns) =>
      ns.map((n) => ({ ...n, tick: n.tick * 10, length: n.length * 10 })),
    );
    fc.assert(
      fc.property(arb, (notes) => {
        const out = glue(notes);
        expect(cover(out)).toEqual(cover(notes));
        const byKey = new Map<number, ScriptNote[]>();
        for (const n of out) byKey.set(n.key, [...(byKey.get(n.key) ?? []), n]);
        for (const list of byKey.values())
          for (let i = 0; i + 1 < list.length; i++) expect(list[i + 1]!.tick).toBeGreaterThan(noteEnd(list[i]!));
      }),
    );
  });
});

describe('strum', () => {
  it('spreads chords over the strum time and keeps note ends', () => {
    fc.assert(
      fc.property(
        notesArb({ maxTick: 8 }, 8),
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom('up', 'down', 'alternate') as fc.Arbitrary<'up' | 'down' | 'alternate'>,
        (raw, time, direction) => {
          const notes = raw.map((n) => ({ ...n, tick: 0 }));
          const out = strum(notes, { time, direction });
          for (const n of out) {
            const src = notes.find((x) => x.id === n.id)!;
            expect(n.tick).toBeGreaterThanOrEqual(0);
            expect(n.tick).toBeLessThanOrEqual(time);
            if (n.tick < noteEnd(src)) expect(noteEnd(n)).toBe(noteEnd(src));
          }
        },
      ),
    );
    const up = strum(
      [
        { id: 'g', tick: 0, length: 960, key: 67, velocity: 1 },
        { id: 'c', tick: 0, length: 960, key: 60, velocity: 1 },
        { id: 'e', tick: 0, length: 960, key: 64, velocity: 1 },
      ],
      { time: 100 },
    );
    expect(up.map((n) => `${n.id}@${n.tick}`)).toEqual(['c@0', 'e@50', 'g@100']);
  });
});

describe('arpeggiate', () => {
  it('plays each chord within its span, one note at a time', () => {
    fc.assert(
      fc.property(
        notesArb({ minKey: 30, maxKey: 90 }, 12),
        fc.integer({ min: 30, max: 480 }),
        fc.integer({ min: 1, max: 4 }),
        (notes, rate, octaves) => {
          const out = arpeggiate(notes, { rate, gate: 1, octaves });
          const sorted = [...out].sort((a, b) => a.tick - b.tick);
          for (let i = 0; i + 1 < sorted.length; i++)
            expect(noteEnd(sorted[i]!)).toBeLessThanOrEqual(sorted[i + 1]!.tick);
          const keys = new Set(notes.flatMap((n) => Array.from({ length: octaves }, (_, o) => n.key + 12 * o)));
          for (const n of out) {
            expect(keys.has(n.key)).toBe(true);
            expect(n.id).toBeUndefined();
            // Inside the time covered by some input note.
            expect(notes.some((m) => m.tick <= n.tick && n.tick < noteEnd(m) + rate)).toBe(true);
          }
        },
      ),
    );
  });

  it('follows the pattern', () => {
    const chord: ScriptNote[] = [60, 64, 67].map((key, i) => ({
      id: `c${i}`,
      tick: 0,
      length: 1440,
      key,
      velocity: 0.5,
    }));
    const keys = (pattern: Parameters<typeof arpeggiate>[1]['pattern'], octaves = 1) =>
      arpeggiate(chord, { rate: 240, pattern, octaves }).map((n) => n.key);
    expect(keys('up')).toEqual([60, 64, 67, 60, 64, 67]);
    expect(keys('down')).toEqual([67, 64, 60, 67, 64, 60]);
    expect(keys('up-down')).toEqual([60, 64, 67, 64, 60, 64]);
    expect(keys('converge')).toEqual([60, 67, 64, 60, 67, 64]);
    expect(keys('up', 2)).toEqual([60, 64, 67, 72, 76, 79]);
    const out = arpeggiate(chord, { rate: 240, gate: 0.5 });
    expect(out.every((n) => n.length === 120 && n.velocity === 0.5)).toBe(true);
  });
});

describe('flip and transpose', () => {
  it('flip twice is the identity', () => {
    fc.assert(
      fc.property(notesArb(), fc.constantFrom('time', 'pitch') as fc.Arbitrary<'time' | 'pitch'>, (notes, axis) => {
        expect(flip(flip(notes, axis), axis)).toEqual(notes);
      }),
    );
    const out = flip(
      [
        { id: 'a', tick: 0, length: 240, key: 60, velocity: 1 },
        { id: 'b', tick: 480, length: 480, key: 67, velocity: 1 },
      ],
      'time',
    );
    expect(out.map((n) => n.tick)).toEqual([720, 0]);
  });

  it('transposing by +n then -n round-trips (semitones, and scale steps for notes in the key)', () => {
    fc.assert(
      fc.property(notesArb({ minKey: 24, maxKey: 103 }), fc.integer({ min: -24, max: 24 }), (notes, n) => {
        expect(transpose(transpose(notes, n), -n)).toEqual(notes);
      }),
    );
    fc.assert(
      fc.property(
        notesArb({ minKey: 30, maxKey: 97 }),
        fc.integer({ min: -10, max: 10 }),
        fc.integer({ min: 0, max: 11 }),
        (raw, n, root) => {
          const k = { root, scale: 'minor-pentatonic' };
          const notes = snapNotesToScale(raw, k);
          const there = transposeDegrees(notes, n, k);
          for (const x of there) expect(inScale(x.key, root, k.scale)).toBe(true);
          expect(transposeDegrees(there, -n, k)).toEqual(notes);
        },
      ),
    );
  });

  it('limits shifts that would leave the key range', () => {
    const notes: ScriptNote[] = [
      { tick: 0, length: 1, key: 120, velocity: 1 },
      { tick: 0, length: 1, key: 100, velocity: 1 },
    ];
    expect(transpose(notes, 12).map((n) => n.key)).toEqual([127, 107]);
    expect(transposeDegrees(notes, 7, { root: 0, scale: 'major' }).every((n) => n.key <= 127)).toBe(true);
  });
});

describe('velocities, limit, chords', () => {
  it('fits velocities into a range', () => {
    const notes: ScriptNote[] = [0.2, 0.4, 0.6].map((velocity, i) => ({ tick: i, length: 1, key: 60, velocity }));
    const levels = (out: readonly ScriptNote[]) => out.map((n) => Math.round(n.velocity * 1000) / 1000);
    expect(levels(fitVelocities(notes, { min: 0.5, max: 1 }))).toEqual([0.5, 0.75, 1]);
    expect(levels(rampVelocities(notes, { from: 0, to: 1 }))).toEqual([0, 0.5, 1]);
    expect(levels(scaleVelocities(notes, { factor: 2 }))).toEqual([0.4, 0.8, 1]);
  });

  it('folds keys into a range by octaves', () => {
    fc.assert(
      fc.property(notesArb(), fc.integer({ min: 0, max: 100 }), (notes, low) => {
        const out = limit(notes, { low, high: low + 12 });
        out.forEach((n, i) => {
          expect(n.key).toBeGreaterThanOrEqual(low);
          expect(n.key).toBeLessThanOrEqual(Math.min(127, low + 12));
          expect((((n.key - notes[i]!.key) % 12) + 12) % 12).toBe(0);
        });
      }),
    );
  });

  it('turns notes into chords, keeping the original note', () => {
    const out = chordify([{ id: 'a', tick: 0, length: 960, key: 62, velocity: 0.7 }], {
      chord: 'diatonic',
      key: { root: 0, scale: 'major' },
    });
    expect(out.map((n) => [n.key, n.id ?? null])).toEqual([
      [62, 'a'],
      [65, null],
      [69, null],
    ]);
  });
});

describe('randomize and generate', () => {
  it('randomize keeps pitches in the scale and within range', () => {
    fc.assert(
      fc.property(
        notesArb({ minKey: 20, maxKey: 100 }),
        fc.integer(),
        fc.integer({ min: 1, max: 12 }),
        (notes, seed, pitch) => {
          const out = randomize(notes, { rand: seeded(seed), pitch, key });
          out.forEach((n, i) => {
            expect(Math.abs(n.key - notes[i]!.key)).toBeLessThanOrEqual(pitch);
            if (n.key !== notes[i]!.key) expect(inScale(n.key, key.root, key.scale)).toBe(true);
          });
        },
      ),
    );
  });

  it('generates seeded notes in key, inside the range, and denser settings only add notes', () => {
    const settings = fc.record({
      seed: fc.integer(),
      low: fc.integer({ min: 30, max: 70 }),
      span: fc.integer({ min: 0, max: 30 }),
      grid: fc.constantFrom(120, 240, 480),
      maxLength: fc.integer({ min: 1, max: 4 }),
      d1: fc.double({ min: 0, max: 1, noNaN: true }),
      d2: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(settings, (s) => {
        const run = (density: number) =>
          generate({
            rand: seeded(s.seed),
            start: 0,
            end: 3840 * 2,
            grid: s.grid,
            density,
            low: s.low,
            high: s.low + s.span,
            maxLength: s.maxLength,
            key,
          });
        const sparse = run(Math.min(s.d1, s.d2));
        const dense = run(Math.max(s.d1, s.d2));
        expect(run(Math.min(s.d1, s.d2))).toEqual(sparse);
        for (const n of dense) {
          expect(n.tick).toBeGreaterThanOrEqual(0);
          expect(noteEnd(n)).toBeLessThanOrEqual(3840 * 2);
          expect(n.key).toBeGreaterThanOrEqual(s.low);
          expect(n.key).toBeLessThanOrEqual(s.low + s.span);
        }
        const keyAt = new Map(dense.map((n) => [n.tick, n.key]));
        for (const n of sparse) expect(keyAt.get(n.tick)).toBe(n.key);
        // Monophonic: no overlaps.
        for (let i = 0; i + 1 < dense.length; i++) expect(noteEnd(dense[i]!)).toBeLessThanOrEqual(dense[i + 1]!.tick);
      }),
    );
    expect(generate({ rand: seeded(1), start: 0, end: 3840, grid: 240, density: 0, low: 60, high: 72 })).toEqual([]);
    expect(generate({ rand: seeded(1), start: 0, end: 3840, grid: 240, density: 1, low: 60, high: 72 })).toHaveLength(
      16,
    );
  });
});
