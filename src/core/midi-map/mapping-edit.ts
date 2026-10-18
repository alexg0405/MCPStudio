/**
 * Small edits of a controller mapping, as pure functions: each returns a new mapping and leaves the old one alone
 * (the controllers manager stores the result and tells the devices about it).
 */
import type { Binding, ControllerMapping } from './types';

/** A binding and its position in the mapping's list. */
export interface IndexedBinding {
  index: number;
  binding: Binding;
}

/** The bindings of a target (any layer), with their position in the mapping. */
export function bindingsOfTarget(mapping: ControllerMapping, target: string): IndexedBinding[] {
  return mapping.bindings.flatMap((binding, index) => (binding.target === target ? [{ index, binding }] : []));
}

/** The mapping without the binding at `index`. */
export function withoutBindingAt(mapping: ControllerMapping, index: number): ControllerMapping {
  return { ...mapping, bindings: mapping.bindings.filter((_, i) => i !== index) };
}

/** The mapping without the bindings of `target`: in every layer, or only in `layer` ('' = the unshifted one) when given. */
export function withoutTarget(mapping: ControllerMapping, target: string, layer?: string): ControllerMapping {
  const isRemoved = (binding: Binding) => binding.target === target && (layer === undefined || (binding.layer ?? '') === layer);
  return { ...mapping, bindings: mapping.bindings.filter((binding) => !isRemoved(binding)) };
}

/**
 * The mapping with the binding at `index` changed. A binding that is not inverted, or scaled by 1, keeps neither
 * field (so saved mappings stay small); an index that is not there changes nothing.
 */
export function withBindingPatch(
  mapping: ControllerMapping,
  index: number,
  patch: Partial<Pick<Binding, 'invert' | 'scale'>>,
): ControllerMapping {
  const binding = mapping.bindings[index];
  if (!binding) return mapping;
  const patched: Binding = { ...binding, ...patch };
  if (!patched.invert) delete patched.invert;
  if (patched.scale === undefined || patched.scale === 1) delete patched.scale;
  return { ...mapping, bindings: mapping.bindings.map((existing, i) => (i === index ? patched : existing)) };
}
