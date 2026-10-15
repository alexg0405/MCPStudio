import { describe, expect, it } from 'vitest';
import { BAR, BEAT } from '../../../test/helpers/arrange';
import type { SectionCaps } from './phrases';
import type { FillChoice, SectionRole } from './sections';
import { boundaryRecipe, classifyBoundary, CRASH_VELOCITY, defaultEnding, endingRecipe, gapBeats, riserBars, type BoundaryKind } from './transitions';

const caps: SectionCaps = { drums: true, hats: true, openHat: true, slide: true };
const side = (role: SectionRole, energy: number, bars = 8, fill: FillChoice = 'auto') => ({ role, energy, bars, fill, caps });
const ctx = (bpm = 150, style: 'trap' | 'house' | 'lofi' = 'trap') => ({ bpm, beatsPerBar: 4, barTicks: BAR, style, fx: 'auto' as const });

describe('classifying boundaries', () => {
  it('reads the energy change, builds into drops, outros and the intro', () => {
    expect(classifyBoundary(null, side('intro', 1))).toBe('intro');
    expect(classifyBoundary(side('verse', 3), side('drop', 5))).toBe('rise');
    expect(classifyBoundary(side('build', 4), side('drop', 5))).toBe('rise');
    expect(classifyBoundary(side('verse', 3), side('chorus', 4))).toBe('lift');
    expect(classifyBoundary(side('drop', 5), side('drop', 5))).toBe('same');
    expect(classifyBoundary(side('drop', 5), side('verse', 4))).toBe('dip');
    expect(classifyBoundary(side('drop', 5), side('break', 2))).toBe('fall');
    expect(classifyBoundary(side('verse', 5), side('build', 2))).toBe('dip');
    expect(classifyBoundary(side('drop', 5), side('outro', 1))).toBe('outro');
    expect(classifyBoundary(side('verse', 3), { ...side('drop', 5), transitionIn: 'same' })).toBe('same');
  });
});

describe('recipe numbers', () => {
  it('a riser lasts 1, 2 or 4 bars, whichever is closest to 6 s', () => {
    expect([150, 124, 90, 75].map((bpm) => riserBars(bpm))).toEqual([4, 4, 2, 2]);
    expect(riserBars(200)).toBe(4);
    expect(riserBars(40)).toBe(1);
  });

  it('the gap grows with the energy jump', () => {
    expect(gapBeats('rise', 2)).toEqual({ gap: 1, stop: 0 });
    expect(gapBeats('rise', 3)).toEqual({ gap: 2, stop: 1 });
    expect(gapBeats('lift', 3)).toEqual({ gap: 0, stop: 0 });
    const small = boundaryRecipe('rise', 16 * BAR, side('verse', 3), side('drop', 5), ctx(), { fill: 0 });
    expect(small.end.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['snare-fill', 8 * BAR - 3 * BEAT, 8 * BAR - BEAT],
      ['gap', 8 * BAR - BEAT, 8 * BAR],
    ]);
    const big = boundaryRecipe('rise', 16 * BAR, side('verse', 2), side('drop', 5), ctx(), { fill: 0 });
    expect(big.end.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['snare-fill', 8 * BAR - 3 * BEAT, 8 * BAR - 2 * BEAT],
      ['gap', 8 * BAR - 2 * BEAT, 8 * BAR],
      ['dropout', 8 * BAR - BEAT, 8 * BAR],
    ]);
  });

  it('a build ends in a snare build over its last 4 bars, cut by the gap', () => {
    const r = boundaryRecipe('rise', 24 * BAR, side('build', 3, 8), side('drop', 5), ctx(), { fill: 0 });
    expect(r.end[0]).toMatchObject({ kind: 'snare-build', from: 4 * BAR, to: 8 * BAR - BEAT, total: 4 * BAR - BEAT });
    expect(r.end[1]).toMatchObject({ kind: 'gap', from: 8 * BAR - BEAT, to: 8 * BAR });
  });

  it('a rise has a riser and a reverse crash ending exactly on X, an impact and a sub drop on it', () => {
    const X = 24 * BAR;
    const r = boundaryRecipe('rise', X, side('verse', 2), side('drop', 5), ctx(150), { fill: 0 });
    const by = (k: string) => r.fx.find((f) => f.kind === k)!;
    expect(by('riser').start + by('riser').beats * BEAT).toBe(X);
    expect(by('riser').beats).toBe(16);
    expect(by('riser').gainDb).toBe(-4);
    expect(by('reverse-crash').start + by('reverse-crash').beats * BEAT).toBe(X);
    expect(by('reverse-crash').gainDb).toBe(-3);
    expect(by('impact')).toMatchObject({ start: X, gainDb: -2 });
    expect(by('sub-drop')).toMatchObject({ start: X, gainDb: -6 });
    expect(r.crash).toBe(1);
    // No sub drop for lo-fi, nor at a smaller jump.
    expect(boundaryRecipe('rise', X, side('verse', 2), side('drop', 5), ctx(80, 'lofi'), { fill: 0 }).fx.map((f) => f.kind)).not.toContain('sub-drop');
    expect(boundaryRecipe('rise', X, side('verse', 3), side('drop', 5), ctx(), { fill: 0 }).fx.map((f) => f.kind)).not.toContain('sub-drop');
    // The riser never starts before A does.
    const short = boundaryRecipe('rise', X, side('verse', 3, 2), side('drop', 5), ctx(), { fill: 0 });
    expect(short.fx.find((f) => f.kind === 'riser')!.beats).toBe(8);
  });

  it('the other kinds get the table’s FX, gains and crashes', () => {
    const X = 16 * BAR;
    const fx = (kind: BoundaryKind, a = side('drop', 5), b = side('verse', 4)) =>
      boundaryRecipe(kind, X, a, b, ctx(), { fill: 0 }).fx.map((f) => [f.kind, f.gainDb, f.start === X ? 'at X' : 'ends at X']);
    expect(fx('lift', side('verse', 3), side('chorus', 4))).toEqual([
      ['riser', -10, 'ends at X'],
      ['reverse-crash', -6, 'ends at X'],
    ]);
    expect(fx('same')).toEqual([]);
    expect(fx('dip')).toEqual([['downlifter', -10, 'at X']]);
    expect(fx('fall', side('drop', 5), side('break', 2))).toEqual([
      ['downlifter', -5, 'at X'],
      ['impact', -8, 'at X'],
    ]);
    expect(fx('outro', side('drop', 5), side('outro', 1))).toEqual([['downlifter', -6, 'at X']]);
    expect(CRASH_VELOCITY).toMatchObject({ rise: 1, lift: 0.9, same: 0.85, dip: 0.7, fall: 0.85, outro: 0.8 });
    const fills = (kind: BoundaryKind) =>
      boundaryRecipe(kind, X, side('drop', 5), side('verse', 4), ctx(), { fill: 0 }).end.map((e) => (e.to - e.from) / BEAT);
    expect([fills('lift'), fills('same'), fills('dip'), fills('fall'), fills('outro')]).toEqual([[2], [2], [1], [1], [1]]);
  });

  it('every curve ends on its control’s own value, except the fade at the very end', () => {
    const X = 16 * BAR;
    const items = [
      ...boundaryRecipe('intro', 0, null, side('intro', 1, 8), ctx(), { fill: 0 }).automation,
      ...boundaryRecipe('rise', X, side('verse', 2), side('drop', 5), ctx(), { fill: 0 }).automation,
      ...boundaryRecipe('fall', X, side('drop', 5), side('break', 2, 8), ctx(), { fill: 0 }).automation,
      ...endingRecipe('stop', { from: X, to: X + 8 * BAR, energy: 1 }, ctx()).automation,
    ];
    expect(items.map((i) => i.purpose).sort()).toEqual(['filter-open', 'filter-open', 'intro-open', 'intro-open', 'sweep-up', 'sweep-up', 'throw', 'throw']);
    for (const i of items) {
      expect(i.points[i.points.length - 1]!.value).toBe('neutral');
      expect(i.points[i.points.length - 1]!.at).toBe(i.length);
    }
    const sweep = items.find((i) => i.purpose === 'sweep-up' && i.target.kind === 'eq' && i.target.bus === 'chords')!;
    expect(sweep.start + sweep.length).toBe(X);
    expect(sweep.points.map((p) => p.value)).toEqual(['neutral', 700, 'neutral']);
    const open = items.find((i) => i.purpose === 'filter-open')!;
    expect(open).toMatchObject({ start: X, length: 4 * BAR });
    expect(open.points[0]!.value).toBe(1200);
    const fade = endingRecipe('fade', { from: 0, to: 8 * BAR, energy: 1 }, ctx()).automation[0]!;
    expect(fade).toMatchObject({ purpose: 'fade', start: 4 * BAR, length: 4 * BAR });
    expect(fade.points[fade.points.length - 1]!.value).toBe(0);
  });

  it('ends trap with a stop and house with a fade', () => {
    expect(defaultEnding('trap')).toBe('stop');
    expect(defaultEnding('house')).toBe('fade');
    const stop = endingRecipe('stop', { from: 8 * BAR, to: 16 * BAR, energy: 1 }, ctx());
    // The last bar plays its first beat, then a crash, an impact and the reverb throw.
    expect(stop.end).toEqual([{ kind: 'dropout', from: 7 * BAR + BEAT, to: 8 * BAR, energy: 1, why: 'end' }]);
    expect(stop.crash).toEqual({ at: 15 * BAR, velocity: 0.95 });
    expect(stop.fx).toEqual([expect.objectContaining({ kind: 'impact', start: 15 * BAR })]);
  });
});
