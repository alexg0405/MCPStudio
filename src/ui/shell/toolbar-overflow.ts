/** Which toolbar slots fit in the width left over, and which go into the "More" dropdown (pure). */

/** The width of the "More" button, in px. */
export const MORE_BUTTON_W = 34;
/** The gap between toolbar slots, in px. */
export const SLOT_GAP = 4;

/** The part of a toolbar slot the layout needs: its id and where it sits among the right-hand slots. */
export interface SlotRef {
  id: string;
  order: number;
}

/**
 * The slots in the order they are given up last to first: the Studio button (the first center slot) first, then the
 * right-hand buttons (the audio chip, which goes away at the first click, last of them), then the other center slots.
 */
export function slotPriority<T extends SlotRef>(center: readonly T[], right: readonly T[]): T[] {
  return [...center.slice(0, 1), ...right.filter((slot) => slot.order > 0), ...right.filter((slot) => slot.order <= 0), ...center.slice(1)];
}

/** The ids of the slots that stay in the bar: all of them when they fit in `available` px, else as many in priority order as fit beside the "More" button. */
export function keptSlotIds(priority: readonly SlotRef[], widthOf: (id: string) => number, available: number): Set<string> {
  const keep = new Set<string>();
  const totalWidth = priority.reduce((sum, slot) => (widthOf(slot.id) ? sum + widthOf(slot.id) + SLOT_GAP : sum), 0);
  if (totalWidth <= available + SLOT_GAP) {
    for (const slot of priority) keep.add(slot.id);
    return keep;
  }
  let used = MORE_BUTTON_W;
  priority.forEach((slot, i) => {
    const width = widthOf(slot.id);
    if (!width) {
      keep.add(slot.id); // an empty slot takes no room
      return;
    }
    // The Studio button (the first) never moves out.
    if (i === 0 || used + width + SLOT_GAP <= available) {
      used += width + SLOT_GAP;
      keep.add(slot.id);
    }
  });
  return keep;
}
