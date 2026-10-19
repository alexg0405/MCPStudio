import { createElement } from 'react';
import type { Services } from '@app/services';
import { TOUCH_LAYOUT_CHOICES, type TouchLayoutChoice } from '@app/stores/prefs';
import { addMenuItems, cmd } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { isTouchLayout } from '../../touch/layout';
import { SearchButton } from './SearchButton';

/** The touch layout switch: bigger buttons and handles for fingers (see `ui/touch/layout.ts`), and the search button it adds. */
export function register({ commands }: Services): void {
  commands.register<string | undefined>({
    id: 'options.touchLayout',
    title: 'Touch layout',
    category: 'View',
    hint: 'Bigger buttons, handles and step squares for fingers. Auto turns it on for tablets and other touch-first devices',
    argsHint: "'auto' (follow the device), 'on' or 'off'; leave it out to switch it on or off",
    run: (s, choice) => {
      const chosen = TOUCH_LAYOUT_CHOICES.find((c): c is TouchLayoutChoice => c === choice);
      s.prefs.getState().set({ touchLayout: chosen ?? (isTouchLayout() ? 'off' : 'on') });
    },
    checked: () => isTouchLayout(),
  });
  addMenuItems('view', [cmd('options.touchLayout', 57.5)]);
  addToolbarSlot({ id: 'touch-search', area: 'right', order: -1, component: () => createElement(SearchButton) });
}
