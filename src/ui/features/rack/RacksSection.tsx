import { useCallback, useSyncExternalStore } from 'react';
import { chainTarget } from '@app/actions/chains';
import { addEmptyRack, addRackChoice, allRacks } from '@app/actions/racks';
import { buildChoice } from '@app/racks/build';
import { exportRackFile, importRackFile, type RackChoice } from '@app/racks/library';
import type { Services } from '@app/services';
import { insertLabel } from '@core/query/mixer';
import { rackSlotToFile } from '@core/rack/file';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import browser from '../../shell/Browser.module.css';
import presets from '../presets/Presets.module.css';
import { openRack } from './open';
import { deleteRackDialog, renameRackDialog } from './rack-dialogs';

/** Puts a rack choice on the track and opens it. */
function putRackOn(s: Services, choice: RackChoice): void {
  const insertId = chainTarget(s);
  const slotId = addRackChoice(s, insertId, choice);
  if (slotId) openRack(s, insertId, slotId);
}

/** Exports a rack choice (a factory rack is made first, only to be written out). */
function exportChoice(s: Services, choice: RackChoice): void {
  if (choice.source === 'user' && choice.id) {
    const mine = s.presets.getRack(choice.id);
    if (mine) exportRackFile(mine.file);
    return;
  }
  const built = buildChoice(s, choice);
  if ('error' in built) s.session.getState().toast(built.error, 'error');
  else exportRackFile(rackSlotToFile(built.slot, choice.name, choice.description));
}

/**
 * Effect racks in the browser: the factory racks and yours. Click one to put it on the mixer track selected in the mixer (the master when
 * none is) and open it. Right-click for export, rename and delete; "Empty rack" starts one from nothing.
 */
export function RacksSection() {
  const s = useServices();
  const subscribe = useCallback(
    (fn: () => void) => {
      const a = s.presets.subscribe(fn);
      const b = s.plugins.subscribe(fn);
      const c = s.session.subscribe((state, prev) => {
        if (state.selectedInsertId !== prev.selectedInsertId) fn();
      });
      return () => {
        a();
        b();
        c();
      };
    },
    [s],
  );
  useSyncExternalStore(subscribe, () => `${s.presets.getVersion()}:${s.plugins.getVersion()}:${s.session.getState().selectedInsertId ?? ''}`);

  const racks = allRacks(s);
  const target = chainTarget(s);
  const where = insertLabel(s.doc.getState().project, target);

  const menu = (e: { clientX: number; clientY: number }, rack: RackChoice) => {
    const entries: MenuEntry[] = [
      { label: `Put on ${where}`, onSelect: () => putRackOn(s, rack), hint: 'Add the rack after the effects the track has (one undo step)' },
      { kind: 'separator' },
      { label: 'Export as file…', onSelect: () => exportChoice(s, rack), hint: 'Download this rack as a .agrack file, to share or keep' },
    ];
    if (rack.source === 'user')
      entries.push(
        { label: `Rename “${rack.name}”…`, onSelect: () => void renameRackDialog(s, rack) },
        { label: `Delete “${rack.name}”…`, danger: true, onSelect: () => void deleteRackDialog(s, rack) },
      );
    showContextMenu(e, entries);
  };

  return (
    <>
      {racks.map((rack) => (
        <button
          key={`${rack.source}/${rack.id ?? rack.name}`}
          className={browser.item}
          onClick={() => putRackOn(s, rack)}
          onContextMenu={(e) => {
            e.preventDefault();
            menu(e, rack);
          }}
          data-hint={`“${rack.name}”: ${rack.description} Inside: ${rack.summary}. Click to put it on ${where}. Right-click for more.`}
        >
          {rack.source === 'user' && <span className={presets.mine}>★</span>}
          {rack.name}
          <span className={browser.badge}>rack</span>
        </button>
      ))}
      <button
        className={browser.item}
        onClick={() => {
          const slotId = addEmptyRack(s, target);
          if (slotId) openRack(s, target, slotId);
        }}
        data-hint={`Put an empty rack on ${where} and fill it with effects, branches and macros yourself`}
      >
        Empty rack
      </button>
      <button className={browser.item} onClick={() => void importRackFile(s)} data-hint="Add a .agrack file (a rack someone shared, or one you exported) to your racks">
        Import a rack file…
      </button>
    </>
  );
}
