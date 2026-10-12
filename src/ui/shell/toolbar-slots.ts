import type { ComponentType } from 'react';

/** Toolbar sections are filled by features (transport, window buttons, meters, …). */
export interface ToolbarSlot {
  id: string;
  area: 'transport' | 'center' | 'right';
  order: number;
  component: ComponentType;
}

const slots = new Map<string, ToolbarSlot>();
const listeners = new Set<() => void>();

export function addToolbarSlot(slot: ToolbarSlot): () => void {
  slots.set(slot.id, slot);
  listeners.forEach((fn) => fn());
  return () => {
    if (slots.get(slot.id) === slot) slots.delete(slot.id);
    listeners.forEach((fn) => fn());
  };
}

export function getToolbarSlots(area: ToolbarSlot['area']): ToolbarSlot[] {
  return [...slots.values()].filter((s) => s.area === area).sort((a, b) => a.order - b.order);
}

export function subscribeToolbar(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
