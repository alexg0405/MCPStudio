import { describe, expect, it } from 'vitest';
import type { PatternId, VariantStep } from '../model/types';
import { BAR, BEAT, HINT, kitProject, trapGroove } from '../../../test/helpers/arrange';
import { notesHash, setHash, toNoteMap } from './notes';
import { inPart, partName } from './roles';
import { applySteps, mergeSteps, normalizeStep, sortSteps, variantEnv, variantKey, variantName, variantSeed } from './variants';

const fill: VariantStep = { kind: 'snare-fill', from: 2 * BAR - 2 * BEAT, to: 2 * BAR, energy: 4 };
const slide: VariantStep = { kind: 'slide', from: 2 * BAR - BEAT, to: 2 * BAR, energy: 4 };

describe('variant names, keys and steps', () => {
  it('names a variant after its source and its changes', () => {
    expect(variantName('Drop', [slide, fill])).toBe('Drop · fill + slide');
    expect(variantName('Drop', [{ kind: 'without', from: 0, to: BAR, parts: ['808', 'hats'] }])).toBe('Drop · no 808, hats');
    expect(variantName('Drop', [{ kind: 'without', from: 0, to: BAR, parts: ['ch_x'] }], () => 'Pluck')).toBe('Drop · no Pluck');
    expect(variantName('Verse', [{ kind: 'thin', from: 0, to: BAR, level: 2 }])).toBe('Verse · sparse');
    expect(variantName('Drop', [])).toBe('Drop');
  });

  it('keys ignore field order and empty fields; the seed follows the source name and steps', () => {
    const a = variantKey('pat_a' as PatternId, [fill, slide]);
    const b = variantKey('pat_a' as PatternId, [{ ...slide, offset: 0 }, { energy: 4, to: fill.to, from: fill.from, kind: 'snare-fill' }]);
    expect(a).toBe(b);
    expect(variantKey('pat_b' as PatternId, [fill, slide])).not.toBe(a);
    expect(variantSeed('Drop', [fill])).toBe(variantSeed('Drop', [fill]));
    expect(variantSeed('Drop', [fill])).not.toBe(variantSeed('Verse', [fill]));
    expect(normalizeStep({ kind: 'thin', from: 0.4, to: 3840.2, level: 5, parts: [] })).toEqual({ kind: 'thin', from: 0, to: 3840, level: 2 });
  });

  it('a new fill replaces an overlapping one; whole-section changes go first', () => {
    const tom: VariantStep = { kind: 'tom-fill', from: 2 * BAR - BEAT, to: 2 * BAR, energy: 4 };
    expect(mergeSteps([fill, slide], [tom]).map((s) => s.kind)).toEqual(['tom-fill', 'slide']);
    expect(mergeSteps([fill], [fill])).toHaveLength(1);
    const thin: VariantStep = { kind: 'thin', from: 0, to: 2 * BAR, level: 1 };
    expect(sortSteps([fill, thin]).map((s) => s.kind)).toEqual(['thin', 'snare-fill']);
  });

  it('applying steps keeps the ones that change something and the result is reproducible', () => {
    const { project, patterns } = kitProject((k) => ({ Groove: { notes: trapGroove(k) } }));
    const env = variantEnv(project, { style: 'trap', hint: HINT });
    const src = project.patterns[patterns.Groove!]!.notes;
    const noop: VariantStep = { kind: 'without', from: 0, to: 2 * BAR, parts: ['vox'] };
    const out = applySteps(src, [fill, noop, slide], env, { seed: 5, length: 2 * BAR });
    expect(out.effective.map((s) => s.kind)).toEqual(['snare-fill', 'slide']);
    // Leaving the no-op out changes nothing else (each step draws from its own seeded generator).
    expect(setHash(applySteps(src, out.effective, env, { seed: 5, length: 2 * BAR }).set)).toBe(setHash(out.set));
    // Hashes ignore note ids.
    expect(notesHash(toNoteMap(out.set))).toBe(notesHash(toNoteMap(out.set)));
    expect(notesHash(toNoteMap(out.set))).toBe(setHash(out.set));
    expect(notesHash(src)).not.toBe(setHash(out.set));
  });
});

describe('parts', () => {
  it('reads part names as people write them and matches kit notes by drum', () => {
    expect(['Hi-hats', '808s', 'the drums', 'melody', 'pads', 'nonsense'].map(partName)).toEqual(['hats', '808', 'drums', 'lead', 'pad', undefined]);
    expect(inPart('hats', 'kit', 42)).toBe(true);
    expect(inPart('hats', 'kit', 36)).toBe(false);
    expect(inPart('drums', 'kit', 70)).toBe(true);
    expect(inPart('bass', '808', 30)).toBe(true);
    expect(inPart('music', 'pad', 60)).toBe(true);
    expect(inPart('music', 'kick', 60)).toBe(false);
  });
});
