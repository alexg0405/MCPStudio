import type { Services } from '@app/services';
import type { InsertId, SlotId } from '@core/model/types';
import { isRackSlot } from '@core/model/rack';
import { locateSlot } from '@core/query/rack';
import { openWindow } from '../../workspace/registry';

/** Opens the rack window of a rack slot. */
export function openRack(s: Services, insertId: InsertId, slotId: SlotId): void {
  openWindow(s, 'rack', { insertId, slotId });
}

/** Opens an effect's own editor: the rack window for a rack, the plugin window for anything else. */
export function openEffect(s: Services, insertId: InsertId, slotId: SlotId): void {
  const slot = locateSlot(s.doc.getState().project.mixer.inserts[insertId], slotId)?.slot;
  if (slot && isRackSlot(slot)) openRack(s, insertId, slotId);
  else openWindow(s, 'plugin', { kind: 'fx', insertId, slotId });
}
