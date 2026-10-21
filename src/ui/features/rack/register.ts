import { chainTarget } from '@app/actions/chains';
import { addEmptyRack, addRackChoice, allRacks, groupSlotsIntoRack } from '@app/actions/racks';
import { findRackChoice, importRackFile } from '@app/racks/library';
import type { Services } from '@app/services';
import { insertLabel } from '@core/query/mixer';
import type { InsertId } from '@core/model/types';
import { addContextMenuItems } from '../../context-menus';
import { addBrowserSection } from '../../shell/Browser';
import { addMenuItems, submenu, type MenuItem } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowType } from '../../workspace/registry';
import { registerMapMenu } from './map-menu';
import { openRack } from './open';
import { RacksSection } from './RacksSection';
import { rackSlotMenu } from './slot-menu';

/** What `mixer.addRack` takes: a rack name from the browser (factory or yours), and the track by name (default: the selected one). */
export type AddRackArgs = string | { rack?: string; insert?: string } | void;

/**
 * Effect racks: a container effect with branches, splits and eight macro knobs (the rack window), "Group into a rack" and
 * "Map to macro" in the menus, the Racks section of the browser, and the Add menu's racks.
 */
export function register(services: Services): void {
  registerWindowType({
    type: 'rack',
    title: (props, s) => {
      const insertId = (props as { insertId?: InsertId } | null)?.insertId;
      return insertId ? `Rack · ${insertLabel(s.doc.getState().project, insertId)}` : 'Rack';
    },
    component: lazyWindow(() => import('./RackWindow'), (m) => m.RackWindow),
    defaultRect: (ws) => ({ x: Math.round(ws.w * 0.12), y: 52, w: Math.min(980, Math.max(560, ws.w - 160)), h: Math.min(580, Math.max(380, ws.h - 100)) }),
    minSize: { w: 460, h: 320 },
    instanceId: (props) => `rack:${(props as { slotId?: string } | null)?.slotId ?? ''}`,
    cascade: true,
  });
  addBrowserSection({ id: 'racks', title: 'Racks', icon: 'mixer', order: 14, component: RacksSection });
  registerMapMenu();
  addContextMenuItems('mixer.slot', rackSlotMenu);

  services.commands.register<AddRackArgs>({
    id: 'mixer.addRack',
    title: 'Put an effect rack on the selected mixer track',
    category: 'Mixer',
    hint: 'Add an effect rack (parallel branches, frequency bands, mid/side or left/right, with eight macro knobs) to the track selected in the mixer; name a factory or saved rack, or leave it out for an empty one',
    argsHint:
      '{ rack?: "Parallel NY compression" | "Multiband saturation" | "Mid/side widener" | "Dub delay throws with macro" | "Lo-fi tape with macro" | one of your rack names (leave out for an empty rack), insert?: track name } (default: the selected track)',
    run: (s, args) => {
      const a = typeof args === 'string' ? { rack: args } : (args ?? {});
      const project = s.doc.getState().project;
      const named = a.insert ? project.mixer.order.find((id) => project.mixer.inserts[id]?.name.toLowerCase() === a.insert!.toLowerCase()) : undefined;
      const insertId = named ?? chainTarget(s);
      if (a.rack) {
        const choice = findRackChoice(allRacks(s), a.rack);
        if (!choice) {
          s.session.getState().toast(`No rack called “${a.rack}”. Look under Racks in the browser.`, 'error');
          return;
        }
        const slotId = addRackChoice(s, insertId, choice);
        if (slotId) openRack(s, insertId, slotId);
        return;
      }
      const slotId = addEmptyRack(s, insertId);
      if (slotId) openRack(s, insertId, slotId);
    },
  });
  services.commands.register({
    id: 'mixer.groupIntoRack',
    title: 'Group the marked effects into a rack',
    category: 'Mixer',
    hint: 'Put the effects marked on the selected track (Ctrl- or Shift-click a slot) into one new rack, where they can get macro knobs and parallel branches',
    // The group_into_rack action does this with the effects named.
    ai: false,
    enabled: (s) => s.session.getState().markedSlotIds.length > 0,
    run: (s) => {
      const insertId = chainTarget(s);
      const slotId = groupSlotsIntoRack(s, insertId, s.session.getState().markedSlotIds);
      s.session.getState().clearMarkedSlots();
      if (slotId) openRack(s, insertId, slotId);
    },
  });
  services.commands.register({
    id: 'mixer.importRack',
    title: 'Import an effect rack file',
    category: 'Mixer',
    hint: 'Add a .agrack file (a rack someone shared, or one you exported) to your racks',
    // It opens a file picker: the browser allows that right after a click, so the studio asks for one.
    gesture: true,
    run: (s) => void importRackFile(s),
  });

  // Add ▸ Effect rack: any rack onto the selected track.
  const rackItems = (): MenuItem[] => {
    const target = chainTarget(services);
    const where = insertLabel(services.doc.getState().project, target);
    return [
      { kind: 'command', command: 'mixer.addRack', order: 0, label: `Empty rack on ${where}` },
      { kind: 'separator', order: 1 },
      ...allRacks(services).map(
        (rack, i): MenuItem => ({
          kind: 'command',
          command: 'mixer.addRack',
          order: 10 + i,
          label: `${rack.name}${rack.source === 'user' ? ' ★' : ''}`,
          args: { rack: rack.name },
        }),
      ),
      { kind: 'separator', order: 100 },
      { kind: 'command', command: 'mixer.groupIntoRack', order: 101, label: 'Group the marked effects into a rack' },
      { kind: 'command', command: 'mixer.importRack', order: 102, label: 'Import a rack file…' },
    ];
  };
  addMenuItems('add', [submenu('racks', 'Effect rack on the selected track', 56, rackItems)]);
}
