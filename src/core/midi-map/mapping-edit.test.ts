import { describe, expect, it } from 'vitest';
import { bindingsOfTarget, withBindingPatch, withoutBindingAt, withoutTarget } from './mapping-edit';
import { emptyMapping, type ControllerMapping } from './types';

function mappingWithBindings(): ControllerMapping {
  return {
    ...emptyMapping('Test'),
    bindings: [
      { input: { type: 'note', channel: 1, note: 10 }, target: 'deck.A.play' },
      { input: { type: 'note', channel: 1, note: 11 }, target: 'deck.A.play', layer: 'shift' },
      { input: { type: 'cc', channel: 1, cc: 5 }, target: 'deck.A.volume' },
    ],
  };
}

describe('mapping edits', () => {
  it('lists the bindings of a target with their positions', () => {
    const found = bindingsOfTarget(mappingWithBindings(), 'deck.A.play');
    expect(found.map((b) => b.index)).toEqual([0, 1]);
  });

  it('removes one binding by position and leaves the original alone', () => {
    const mapping = mappingWithBindings();
    const edited = withoutBindingAt(mapping, 1);
    expect(edited.bindings.map((b) => b.target)).toEqual(['deck.A.play', 'deck.A.volume']);
    expect(mapping.bindings).toHaveLength(3);
  });

  it('clears a target in every layer, or only in the layer asked for', () => {
    const mapping = mappingWithBindings();
    expect(withoutTarget(mapping, 'deck.A.play').bindings).toHaveLength(1);
    expect(withoutTarget(mapping, 'deck.A.play', '').bindings).toHaveLength(2);
    expect(withoutTarget(mapping, 'deck.A.play', 'shift').bindings).toHaveLength(2);
  });

  it('drops fields that say nothing (not inverted, scale 1) and ignores a missing index', () => {
    const mapping = withBindingPatch(mappingWithBindings(), 2, { invert: true, scale: 2 });
    expect(mapping.bindings[2]).toMatchObject({ invert: true, scale: 2 });
    const plain = withBindingPatch(mapping, 2, { invert: false, scale: 1 });
    expect(plain.bindings[2]).not.toHaveProperty('invert');
    expect(plain.bindings[2]).not.toHaveProperty('scale');
    expect(withBindingPatch(plain, 9, { invert: true })).toBe(plain);
  });
});
