/** The questions the rack features ask: what to call a rack that is saved, and whether to replace or delete one of yours. */
import { rackAt, saveRackAs } from '@app/actions/racks';
import { exportRackFile, type RackChoice } from '@app/racks/library';
import type { Services } from '@app/services';
import type { InsertId, SlotId } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import { rackSlotToFile } from '@core/rack/file';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';

/** Asks for a name (and a sentence) and saves the rack as one of your own. A rack of the same name is replaced after one question. */
export async function saveRackDialog(s: Services, insertId: InsertId, slotId: SlotId, suggestion = ''): Promise<void> {
  const slot = rackAt(s, insertId, slotId);
  if (!slot) return;
  const where = insertLabel(s.doc.getState().project, insertId);
  const got = await showFormDialog({
    title: 'Save this rack',
    message: `Saves the rack on ${where} with its effects, every setting, its macros and what they move, so you can put it on any track in any project.`,
    fields: [
      { kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. My drum crush' },
      { kind: 'text', key: 'description', label: 'What it is for (optional)', placeholder: 'e.g. Parallel crush with a Blend macro' },
    ],
    values: { name: suggestion, description: '' },
    okLabel: 'Save',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name) return;
  if (s.presets.findRack(name)) {
    const answer = await showDialog({
      title: 'Replace the rack?',
      message: `You already have a rack called “${name}”.`,
      detail: 'Replacing it keeps the name and saves this rack in it.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'replace', label: 'Replace', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'replace') return;
  }
  const saved = saveRackAs(s, insertId, slotId, name, String(got?.description ?? ''));
  if (saved) s.session.getState().toast(`Saved “${saved.file.name}”. It’s under Racks in the browser and in the Add menu.`);
}

/** Downloads the rack of a track as a `.agrack` file, to share or keep. */
export function exportRackSlot(s: Services, insertId: InsertId, slotId: SlotId): void {
  const slot = rackAt(s, insertId, slotId);
  if (!slot) return;
  exportRackFile(rackSlotToFile(slot, `Rack on ${insertLabel(s.doc.getState().project, insertId)}`));
}

export async function renameRackDialog(s: Services, rack: RackChoice): Promise<void> {
  if (rack.source !== 'user' || !rack.id) return;
  const got = await showFormDialog({
    title: 'Rename rack',
    fields: [{ kind: 'text', key: 'name', label: 'Name' }],
    values: { name: rack.name },
    okLabel: 'Rename',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name || name === rack.name) return;
  if (!s.presets.renameRack(rack.id, name)) s.session.getState().toast(`You already have a rack called “${name}”.`, 'error');
}

export async function deleteRackDialog(s: Services, rack: RackChoice): Promise<void> {
  if (rack.source !== 'user' || !rack.id) return;
  const answer = await showDialog({
    title: 'Delete the rack?',
    message: `“${rack.name}” will be gone from your racks.`,
    detail: 'Racks already on tracks stay. To keep a copy, export it as a file first.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', danger: true, primary: true },
    ],
    cancelId: 'cancel',
  });
  if (answer === 'delete') s.presets.removeRack(rack.id);
}
