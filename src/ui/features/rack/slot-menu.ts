/**
 * What the right-click menu of an effect slot in the mixer offers for racks: group effects into one, take a rack apart, open it, save
 * it, and mark effects to group several at once (Ctrl- or Shift-click on a slot does the same).
 */
import { groupSlotsIntoRack, ungroupSlot } from '@app/actions/racks';
import type { Services } from '@app/services';
import { isRackSlot } from '@core/model/rack';
import type { InsertId, SlotId } from '@core/model/types';
import type { MenuEntry } from '../../controls/ContextMenu';
import { exportRackSlot, saveRackDialog } from './rack-dialogs';
import { openRack } from './open';

/** The effects a "Group into a rack" acts on: the marked ones when the clicked slot is one of them, else just the clicked one. */
export function slotsToGroup(s: Services, insertId: InsertId, slotId: SlotId): SlotId[] {
  const marked = s.session.getState().markedSlotIds;
  const fx = s.doc.getState().project.mixer.inserts[insertId]?.fx ?? [];
  const onTrack = marked.filter((id) => fx.some((slot) => slot.id === id));
  return onTrack.includes(slotId) ? onTrack : [slotId];
}

/** The rack entries of one slot's menu. */
export function rackSlotMenu(ctx: { insertId: InsertId; slotId: SlotId }, s: Services): MenuEntry[] {
  const { insertId, slotId } = ctx;
  const slot = s.doc.getState().project.mixer.inserts[insertId]?.fx.find((candidate) => candidate.id === slotId);
  if (!slot) return [];
  const label = (text: string) => ({ kind: 'label' as const, label: text });
  if (isRackSlot(slot)) {
    return [
      label('Rack'),
      { label: 'Open rack', onSelect: () => openRack(s, insertId, slotId), hint: 'Open the rack: its branches, effects and macros' },
      { label: 'Ungroup', onSelect: () => void ungroupSlot(s, insertId, slotId), hint: 'Take the rack apart: its effects go back on the track in its place' },
      { label: 'Save as my rack…', onSelect: () => void saveRackDialog(s, insertId, slotId), hint: 'Keep this rack in your racks (browser and Add menu)' },
      { label: 'Export as a file…', onSelect: () => exportRackSlot(s, insertId, slotId), hint: 'Download the rack as a .agrack file' },
    ];
  }
  const picked = slotsToGroup(s, insertId, slotId);
  const isMarked = s.session.getState().markedSlotIds.includes(slotId);
  const hasSidechain = slot.sidechain !== null;
  return [
    label('Rack'),
    {
      label: picked.length > 1 ? `Group ${picked.length} marked effects into a rack` : 'Group into a rack',
      disabled: hasSidechain && picked.length === 1,
      hint: hasSidechain
        ? 'An effect with a sidechain input cannot go in a rack: clear its sidechain first'
        : 'Put this effect (or the marked ones) in a new rack, where it can get macro knobs and parallel branches (one undo step)',
      onSelect: () => {
        groupSlotsIntoRack(s, insertId, picked);
        s.session.getState().clearMarkedSlots();
      },
    },
    {
      label: isMarked ? 'Unmark for grouping' : 'Mark for grouping',
      hint: 'Mark several effects (Ctrl- or Shift-click a slot does this too), then choose Group into a rack on one of them',
      onSelect: () => s.session.getState().toggleMarkedSlot(slotId),
    },
  ];
}
