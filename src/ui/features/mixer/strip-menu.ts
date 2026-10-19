import { PALETTE } from '@core/model/defaults';
import type { InsertId } from '@core/model/types';
import { MASTER } from '@core/model/types';
import { setInsertProp } from '@core/ops/mixer';
import { addMixerInsert, deleteInsert, moveInsertBy, routeChannel } from '@app/actions/mixer';
import type { Services } from '@app/services';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { stripGroupEntries } from './group-menu';

/** What the right-click menu of a strip needs to know about it. */
export interface StripMenuInput {
  services: Services;
  id: InsertId;
  /** The strip's position: 0 is the Master, 1… the tracks. */
  index: number;
  /** "Master" or "Insert 3": the name used in undo labels. */
  label: string;
  /** The strip's name as shown ("Kick"). */
  name: string;
  color: string | undefined;
  isLast: boolean;
  startRename(): void;
}

/** Rename, color, routing, ordering, insert and delete: the entries of a strip's right-click menu. */
export function stripMenuEntries(input: StripMenuInput): MenuEntry[] {
  const { services, id, index, label, name, color, isLast, startRename } = input;
  const isMaster = id === MASTER;
  // The selection stays: the menu routes the selected insert to this one (FL: select the source,
  // right-click the destination). Everything else in it acts on this strip.
  const project = services.doc.getState().project;
  const selectedChannelId = services.session.getState().selectedChannelId;
  const selectedChannel = selectedChannelId ? project.channels[selectedChannelId] : undefined;
  const setColor = (newColor: string | undefined) =>
    services.history.transact(`${label} color`, (draft) => setInsertProp(draft, id, 'color', newColor));

  const entries: MenuEntry[] = [
    { label: 'Rename…', onSelect: startRename },
    {
      kind: 'swatches',
      colors: PALETTE,
      ...(color ? { selected: color } : {}),
      onSelect: (swatch) => setColor(swatch),
    },
  ];
  if (color) entries.push({ label: 'Clear color', onSelect: () => setColor(undefined) });
  entries.push({ kind: 'separator' });
  if (selectedChannel && selectedChannelId && selectedChannel.kind !== 'automation') {
    const alreadyHere = selectedChannel.output === id;
    entries.push({
      label: `Route “${selectedChannel.name}” here`,
      disabled: alreadyHere,
      hint: alreadyHere
        ? `“${selectedChannel.name}” already plays through ${name}`
        : `Play channel “${selectedChannel.name}” through ${name}`,
      onSelect: () => routeChannel(services, selectedChannelId, id),
    });
  }
  if (!isMaster) {
    entries.push(
      { label: 'Move left', disabled: index <= 1, onSelect: () => moveInsertBy(services, id, -1) },
      { label: 'Move right', disabled: isLast, onSelect: () => moveInsertBy(services, id, 1) },
    );
  }
  entries.push({ label: 'Insert new track after', onSelect: () => addMixerInsert(services, index) });
  entries.push(...extraMenuItems('mixer.strip', { insertId: id }, services));
  if (!isMaster) entries.push({ kind: 'separator' }, ...stripGroupEntries(services, id));
  if (!isMaster) {
    entries.push({ kind: 'separator' }, { label: 'Delete', danger: true, onSelect: () => deleteInsert(services, id) });
  }
  return entries;
}
