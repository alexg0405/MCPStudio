import { describe, expect, it } from 'vitest';
import { analysisTags, browse, cleanTag, countByCategory, fitsKey, isUnder, matches, NO_FILTER, searchWords, semitonesToKey, similarTo, sortRows, type SampleFilter, type SampleRow } from './query';
import { distance } from './similarity';
import { SAMPLE_ANALYSIS_VERSION, type SampleAnalysis } from './types';

const analysis = (over: Partial<SampleAnalysis>): SampleAnalysis => ({
  v: SAMPLE_ANALYSIS_VERSION,
  kind: 'one-shot',
  durationSec: 0.4,
  category: null,
  confidence: 0.9,
  loudnessDb: -12,
  peakDb: -1,
  brightness: 1000,
  vec: [],
  ...over,
});

let n = 0;
const row = (name: string, a: Partial<SampleAnalysis> | null, over: Partial<SampleRow> = {}): SampleRow => ({
  id: `r${n++}`,
  name,
  folder: 'Pack',
  path: `${name}.wav`,
  analysis: a ? analysis(a) : null,
  favorite: false,
  userTags: [],
  lastUsed: 0,
  ...over,
});

const rows: SampleRow[] = [
  row('Kick Deep', { category: 'kick', root: 1, midi: 37.1, durationSec: 0.5 }),
  row('Kick Punch', { category: 'kick', durationSec: 0.3 }, { favorite: true, lastUsed: 300, userTags: ['punchy'] }),
  row('Snare 01', { category: 'snare', durationSec: 0.25 }, { lastUsed: 100 }),
  row('Hat 05', { category: 'hat', durationSec: 0.06, brightness: 11000 }),
  row('808 A', { category: '808', root: 9, midi: 33, durationSec: 2.4 }),
  row('Drum Loop 128', { kind: 'loop', bpm: 128, bars: 4, loopKind: 'drums', durationSec: 7.5, brightness: 3000 }),
  row('Drum Loop 90', { kind: 'loop', bpm: 90, bars: 2, loopKind: 'drums', durationSec: 5.3 }, { path: 'Loops/Drum Loop 90.wav' }),
  row('Keys Loop', { kind: 'loop', bpm: 128, bars: 4, loopKind: 'melodic', root: 9, mode: 'minor', durationSec: 7.5 }),
  row('Pad C', { category: 'tonal', root: 0, midi: 60, durationSec: 3 }),
  row('Not analyzed yet', null),
];
const names = (r: readonly SampleRow[]) => r.map((x) => x.name);
const f = (over: Partial<SampleFilter>): SampleFilter => ({ ...NO_FILTER, ...over });

describe('tags', () => {
  it('describes a one-shot and a loop in words', () => {
    expect(analysisTags(rows[0]!.analysis)).toEqual(['one-shot', 'kick', 'low', 'c♯', 'warm']);
    expect(analysisTags(rows[5]!.analysis)).toEqual(['loop', 'drums loop', '128 bpm', '4 bars', 'warm']);
    expect(analysisTags(rows[7]!.analysis)).toContain('a minor');
    expect(analysisTags(null)).toEqual([]);
  });
});

describe('search', () => {
  it('finds words in names, paths, tags, tempo, key and your own tags', () => {
    expect(names(rows.filter((r) => matches(r, f({ text: 'kick' }))))).toEqual(['Kick Deep', 'Kick Punch']);
    expect(names(rows.filter((r) => matches(r, f({ text: 'punchy' }))))).toEqual(['Kick Punch']);
    expect(names(rows.filter((r) => matches(r, f({ text: '128 bpm' }))))).toEqual(['Drum Loop 128', 'Keys Loop']);
    expect(names(rows.filter((r) => matches(r, f({ text: 'a minor' }))))).toEqual(['Keys Loop']);
    expect(names(rows.filter((r) => matches(r, f({ text: 'loops/' }))))).toEqual(['Drum Loop 90']);
    expect(names(rows.filter((r) => matches(r, f({ text: 'favorite' }))))).toEqual(['Kick Punch']);
  });

  it('needs every word, ignores case, and "-word" leaves matches out', () => {
    expect(names(rows.filter((r) => matches(r, f({ text: 'KICK deep' }))))).toEqual(['Kick Deep']);
    expect(names(rows.filter((r) => matches(r, f({ text: 'kick -deep' }))))).toEqual(['Kick Punch']);
    expect(names(rows.filter((r) => matches(r, f({ text: '   ' }))))).toHaveLength(rows.length);
    expect(searchWords('a -b  c')).toEqual({ has: ['a', 'c'], not: ['b'] });
    expect(searchWords('-')).toEqual({ has: ['-'], not: [] });
  });
});

describe('filters', () => {
  it('by category, kind, favorites, recently used and your tags', () => {
    expect(names(rows.filter((r) => matches(r, f({ categories: ['kick', 'snare'] }))))).toEqual(['Kick Deep', 'Kick Punch', 'Snare 01']);
    expect(names(rows.filter((r) => matches(r, f({ kind: 'loop' }))))).toEqual(['Drum Loop 128', 'Drum Loop 90', 'Keys Loop']);
    expect(names(rows.filter((r) => matches(r, f({ kind: 'one-shot' }))))).toHaveLength(6);
    expect(names(rows.filter((r) => matches(r, f({ favorites: true }))))).toEqual(['Kick Punch']);
    expect(names(rows.filter((r) => matches(r, f({ recent: true }))))).toEqual(['Kick Punch', 'Snare 01']);
    expect(names(rows.filter((r) => matches(r, f({ tags: ['punchy'] }))))).toEqual(['Kick Punch']);
    expect(names(rows.filter((r) => matches(r, f({ tags: ['punchy', 'other'] }))))).toEqual([]);
  });

  it('by tempo range, with halves and doubles when asked', () => {
    expect(names(rows.filter((r) => matches(r, f({ bpm: [120, 130] }))))).toEqual(['Drum Loop 128', 'Keys Loop']);
    expect(names(rows.filter((r) => matches(r, f({ bpm: [60, 100] }))))).toEqual(['Drum Loop 90']);
    expect(names(rows.filter((r) => matches(r, f({ bpm: [170, 190], halfDouble: false }))))).toEqual([]);
    expect(names(rows.filter((r) => matches(r, f({ bpm: [170, 190], halfDouble: true }))))).toEqual(['Drum Loop 90']);
    // One-shots have no tempo: a tempo filter leaves them out.
    expect(names(rows.filter((r) => matches(r, f({ bpm: [0, 300] }))))).toEqual(['Drum Loop 128', 'Drum Loop 90', 'Keys Loop']);
  });

  it('by key (the note of a one-shot or the key of a loop)', () => {
    expect(names(rows.filter((r) => matches(r, f({ keys: [9] }))))).toEqual(['808 A', 'Keys Loop']);
    expect(names(rows.filter((r) => matches(r, f({ keys: [0, 1] }))))).toEqual(['Kick Deep', 'Pad C']);
  });

  it('by folder (the folder and what is below it)', () => {
    expect(names(rows.filter((r) => matches(r, f({ under: 'Pack/Loops' }))))).toEqual(['Drum Loop 90']);
    expect(names(rows.filter((r) => matches(r, f({ under: 'Pack' }))))).toHaveLength(rows.length);
    expect(names(rows.filter((r) => matches(r, f({ under: 'Other' }))))).toEqual([]);
    expect(names(rows.filter((r) => matches(r, f({ under: 'Pack/Loop' }))))).toEqual([]);
    expect(isUnder({ folder: 'A', path: 'x/y.wav' }, 'A/x/')).toBe(true);
    expect(isUnder({ folder: 'A', path: 'x/y.wav' }, 'A/x/y.wav')).toBe(true);
  });

  it('combines filters, and rows not analyzed yet only show with no analysis filter on', () => {
    expect(names(rows.filter((r) => matches(r, f({ categories: ['kick'], favorites: true, text: 'punch' }))))).toEqual(['Kick Punch']);
    expect(names(rows.filter((r) => matches(r, NO_FILTER)))).toContain('Not analyzed yet');
    expect(names(rows.filter((r) => matches(r, f({ kind: 'loop' }))))).not.toContain('Not analyzed yet');
    expect(names(rows.filter((r) => matches(r, f({ categories: ['kick'] }))))).not.toContain('Not analyzed yet');
  });
});

describe('sort', () => {
  it('by name with numbers in order, either way', () => {
    const r = [row('b 10', null), row('b 2', null), row('a', null)];
    expect(names(sortRows(r, 'name'))).toEqual(['a', 'b 2', 'b 10']);
    expect(names(sortRows(r, 'name', true))).toEqual(['b 10', 'b 2', 'a']);
  });

  it('by tempo with sounds that have none last, whichever the direction', () => {
    expect(names(sortRows(rows, 'bpm')).slice(0, 3)).toEqual(['Drum Loop 90', 'Drum Loop 128', 'Keys Loop']);
    expect(names(sortRows(rows, 'bpm', true)).slice(0, 3)).toEqual(['Drum Loop 128', 'Keys Loop', 'Drum Loop 90']);
    expect(sortRows(rows, 'bpm').at(-1)!.analysis?.bpm).toBeUndefined();
    expect(sortRows(rows, 'bpm', true).at(-1)!.analysis?.bpm).toBeUndefined();
  });

  it('by key (C first, minor after major of a note), length, loudness, type and recently used', () => {
    expect(names(sortRows(rows, 'key')).slice(0, 4)).toEqual(['Pad C', 'Kick Deep', '808 A', 'Keys Loop']);
    expect(names(sortRows(rows, 'length')).slice(0, 3)).toEqual(['Hat 05', 'Snare 01', 'Kick Punch']);
    expect(names(sortRows(rows, 'length', true))[0]).toBe('Drum Loop 128');
    expect(names(sortRows(rows, 'category')).slice(0, 4)).toEqual(['Kick Deep', 'Kick Punch', 'Snare 01', 'Hat 05']);
    expect(names(sortRows(rows, 'recent')).slice(0, 2)).toEqual(['Kick Punch', 'Snare 01']);
    expect(sortRows(rows, 'recent').at(-1)!.lastUsed).toBe(0);
    expect(sortRows([row('x', { loudnessDb: -6 }), row('y', { loudnessDb: -20 })], 'loudness')[0]!.name).toBe('y');
  });

  it('browse filters then sorts, and does not change its input', () => {
    const copy = [...rows];
    expect(names(browse(rows, f({ kind: 'loop' }), 'bpm'))).toEqual(['Drum Loop 90', 'Drum Loop 128', 'Keys Loop']);
    expect(rows).toEqual(copy);
  });
});

describe('similar sounds', () => {
  const v = (...x: number[]) => [...x, ...Array(13 - x.length).fill(0)];
  it('ranks by distance within the same kind and puts the same category first among near ties', () => {
    const target = row('t', { category: 'kick', vec: v(0.2, 0.6, 0.4) });
    const near = row('near', { category: 'kick', vec: v(0.22, 0.58, 0.4) });
    const far = row('far', { category: 'kick', vec: v(0.8, 0.1, 0.1) });
    const otherKind = row('loop', { kind: 'loop', vec: v(0.2, 0.6, 0.4) });
    const nearOther = row('nearOther', { category: 'tom', vec: v(0.2, 0.6, 0.4) });
    const none = row('none', null);
    const out = similarTo([target, far, near, otherKind, nearOther, none], target);
    expect(out.map((x) => x.row.name)).toEqual(['near', 'nearOther', 'far']);
    expect(out[0]!.distance).toBeLessThan(out[1]!.distance);
    expect(similarTo([target, far, near], target, 1)).toHaveLength(1);
    expect(similarTo([target], row('x', null))).toEqual([]);
  });

  it('is a distance: zero for the same fingerprint, symmetric, growing with the difference', () => {
    const a = v(0.1, 0.5, 0.9);
    const b = v(0.2, 0.4, 0.8);
    expect(distance(a, a)).toBe(0);
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 12);
    expect(distance(a, v(0.9, 0.1, 0.1))).toBeGreaterThan(distance(a, b));
  });
});

describe('keys', () => {
  it('fits notes in the scale of the song key and loops in the key or its relative', () => {
    const cMajor = { root: 0, scale: 'major' };
    expect(fitsKey(analysis({ root: 7 }), cMajor)).toBe(true);
    expect(fitsKey(analysis({ root: 6 }), cMajor)).toBe(false);
    expect(fitsKey(analysis({ kind: 'loop', root: 0, mode: 'major' }), cMajor)).toBe(true);
    expect(fitsKey(analysis({ kind: 'loop', root: 9, mode: 'minor' }), cMajor)).toBe(true);
    expect(fitsKey(analysis({ kind: 'loop', root: 2, mode: 'minor' }), cMajor)).toBe(false);
    expect(fitsKey(analysis({ kind: 'loop', root: 1, mode: 'minor' }), cMajor)).toBe(false);
    expect(fitsKey(analysis({ root: 3 }), { root: 0, scale: 'minor' })).toBe(true);
    expect(fitsKey(analysis({ root: 4 }), { root: 0, scale: 'minor' })).toBe(false);
    expect(fitsKey(analysis({}), cMajor)).toBe(false);
    expect(fitsKey(analysis({ root: 0 }), undefined)).toBe(false);
  });

  it('turns a note onto the tonic by the smallest shift', () => {
    expect(semitonesToKey(0, 0)).toBe(0);
    expect(semitonesToKey(9, 0)).toBe(3);
    expect(semitonesToKey(3, 0)).toBe(-3);
    expect(semitonesToKey(6, 0)).toBe(-6);
    expect(semitonesToKey(0, 7)).toBe(-5);
    for (let r = 0; r < 12; r++) for (let t = 0; t < 12; t++) expect(Math.abs(semitonesToKey(r, t))).toBeLessThanOrEqual(6);
  });
});

describe('counts and tags', () => {
  it('counts what the chips show', () => {
    const c = countByCategory(rows);
    expect(c.byCategory.get('kick')).toBe(2);
    expect(c.loops).toBe(3);
    expect(c.oneShots).toBe(6);
    expect(c.analyzed).toBe(9);
  });

  it('cleans your tags', () => {
    expect(cleanTag('  Dark   Kick ')).toBe('dark kick');
    expect(cleanTag('x'.repeat(40))).toHaveLength(24);
    expect(cleanTag('   ')).toBe('');
  });
});
