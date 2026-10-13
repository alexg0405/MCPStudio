import type { ComponentType } from 'react';

/** Feature-owned overlays (modals, panels) rendered above the workspace by the shell. */
const overlays = new Map<string, ComponentType>();
const listeners = new Set<() => void>();
let version = 0;

export function addOverlay(id: string, component: ComponentType): () => void {
  overlays.set(id, component);
  version++;
  listeners.forEach((fn) => fn());
  return () => {
    if (overlays.get(id) === component) overlays.delete(id);
    version++;
    listeners.forEach((fn) => fn());
  };
}

export function getOverlays(): [string, ComponentType][] {
  return [...overlays];
}

export function subscribeOverlays(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function overlaysVersion(): number {
  return version;
}
