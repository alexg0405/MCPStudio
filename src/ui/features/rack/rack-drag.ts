/**
 * What is dragged onto a rack's branches: one of the rack's own effects (to move it to another branch or place), or an effect from the
 * browser (to add it). The payloads are small JSON or a plugin id under their own drag types.
 */
import type { InsertId, SlotId } from '@core/model/types';

/** An effect card of a rack being moved. */
export const RACK_FX_DRAG = 'application/x-agstudio-rack-fx';
/** An effect of the browser being added (its plugin id). */
export const EFFECT_DRAG = 'application/x-agstudio-effect';

/** Starts dragging an effect card. */
export function startCardDrag(event: React.DragEvent, insertId: InsertId, slotId: SlotId): void {
  event.dataTransfer.setData(RACK_FX_DRAG, JSON.stringify({ insertId, slotId }));
  event.dataTransfer.effectAllowed = 'move';
}

/** Starts dragging an effect out of the browser. */
export function startEffectDrag(event: React.DragEvent, pluginId: string): void {
  event.dataTransfer.setData(EFFECT_DRAG, pluginId);
  event.dataTransfer.effectAllowed = 'copy';
}

/** Whether a drag can be dropped on a branch. */
export function canDropOnBranch(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(RACK_FX_DRAG) || dataTransfer.types.includes(EFFECT_DRAG);
}

/** What was dropped: a card of this track's racks, or a plugin id to add; null for anything else. */
export function readDrop(
  dataTransfer: DataTransfer,
): { kind: 'card'; insertId: InsertId; slotId: SlotId } | { kind: 'plugin'; pluginId: string } | null {
  const card = dataTransfer.getData(RACK_FX_DRAG);
  if (card) {
    try {
      const parsed = JSON.parse(card) as { insertId?: InsertId; slotId?: SlotId };
      if (parsed.insertId && parsed.slotId) return { kind: 'card', insertId: parsed.insertId, slotId: parsed.slotId };
    } catch {
      return null;
    }
  }
  const pluginId = dataTransfer.getData(EFFECT_DRAG);
  return pluginId ? { kind: 'plugin', pluginId } : null;
}
