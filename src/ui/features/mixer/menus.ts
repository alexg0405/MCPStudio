import type { FxSlot, InsertId } from '@core/model/types';
import type { Services } from '@app/services';
import type { MenuEntry } from '../../controls/ContextMenu';
import { openWindow } from '../../workspace/registry';

/** Every installed effect (built-ins first, then your plugins). */
export function effectMenu(services: Services, pick: (pluginId: string) => void, current?: string): MenuEntry[] {
  const effects = services.plugins.list('effect');
  if (effects.length === 0) return [{ label: 'No effects installed', disabled: true, onSelect: () => {} }];
  const out: MenuEntry[] = [{ kind: 'label', label: 'Effects' }];
  let user = false;
  for (const e of effects) {
    if (e.source === 'user' && !user) {
      user = true;
      out.push({ kind: 'separator' }, { kind: 'label', label: 'Your plugins' });
    }
    out.push({ label: e.def.name, checked: e.def.id === current, onSelect: () => pick(e.def.id) });
  }
  return out;
}

export function openEffectEditor(services: Services, insertId: InsertId, slotId: FxSlot['id']): void {
  openWindow(services, 'plugin', { kind: 'fx', insertId, slotId });
}
