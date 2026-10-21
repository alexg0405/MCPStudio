/**
 * "Map to macro" for anything in a rack a macro can move: the entry every such control's right-click menu gets (an effect's setting
 * and dry/wet in a rack window or its own editor, the rack's output, and the branch levels, pans and crossovers of the rack window).
 */
import { mapToMacro, rackAt } from '@app/actions/racks';
import type { Services } from '@app/services';
import { sameMacroTarget } from '@core/model/rack';
import type { InsertId, MacroTarget, SlotId } from '@core/model/types';
import { removeMacroMapping } from '@core/ops/racks';
import { rackControlOf } from '@core/query/rack';
import type { MenuEntry } from '../../controls/ContextMenu';
import { addParamMenuItems } from '../../param-menu';

/** The macro (0-based) that moves the target, or -1. */
function macroOf(s: Services, insertId: InsertId, rackSlotId: SlotId, target: MacroTarget): number {
  const slot = rackAt(s, insertId, rackSlotId);
  return slot ? slot.rack.macros.findIndex((macro) => macro.mappings.some((mapping) => sameMacroTarget(mapping.target, target))) : -1;
}

/** The "Map to macro" submenu for a target of the rack (empty when the rack is gone). */
export function mapToMacroEntries(s: Services, insertId: InsertId, rackSlotId: SlotId, target: MacroTarget): MenuEntry[] {
  const slot = rackAt(s, insertId, rackSlotId);
  if (!slot) return [];
  const owner = macroOf(s, insertId, rackSlotId, target);
  const ownerName = owner >= 0 ? slot.rack.macros[owner]?.name : undefined;
  return [
    {
      kind: 'submenu',
      label: owner >= 0 ? `Map to macro (now ${owner + 1} “${ownerName}”)` : 'Map to macro',
      hint: 'Let one of the rack’s eight macro knobs move this. It starts where the setting is now and sweeps the room it has; set the range in the rack window',
      items: () => {
        const macros = rackAt(s, insertId, rackSlotId)?.rack.macros ?? [];
        const entries: MenuEntry[] = macros.map((macro, index) => ({
          label: `${index + 1}  ${macro.name}`,
          checked: index === owner,
          onSelect: () => {
            if (index !== owner) mapToMacro(s, insertId, rackSlotId, index, target);
          },
          hint: `Macro ${index + 1} “${macro.name}” moves ${macro.mappings.length === 0 ? 'nothing yet' : `${macro.mappings.length} thing${macro.mappings.length === 1 ? '' : 's'} now`}`,
        }));
        if (owner >= 0) {
          entries.push(
            { kind: 'separator' },
            {
              label: 'Let go of the macro',
              hint: 'The setting follows its own value again',
              onSelect: () => void s.history.transact('Let go of the macro', (d) => void removeMacroMapping(d, insertId, rackSlotId, owner, target)),
            },
          );
        }
        return entries;
      },
    },
  ];
}

/** Adds "Map to macro" to the param menu of every control inside a rack (an effect's settings and dry/wet, the rack's output). */
export function registerMapMenu(): () => void {
  return addParamMenuItems((info, s) => {
    const control = rackControlOf(s.doc.getState().project, info.target);
    return control ? mapToMacroEntries(s, control.insertId, control.rackSlot.id, control.macroTarget) : [];
  });
}
