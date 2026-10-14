import type { Services } from '@app/services';
import { addMenuItems, cmd } from '../shell/menus';
import { isWindowOpen, toggleWindow } from './registry';

/** Registers the standard "show/hide <window>" command with its shortcuts and View-menu entry. */
export function registerWindowToggle(
  services: Services,
  opts: {
    command: string;
    type: string;
    title: string;
    hint?: string;
    chords: string[];
    menuOrder: number;
    /** False keeps the toggle away from the AI studio (see CommandDef.ai). */
    ai?: boolean;
  },
): void {
  services.commands.register({
    id: opts.command,
    title: opts.title,
    category: 'View',
    ...(opts.hint ? { hint: opts.hint } : {}),
    ...(opts.ai === false ? { ai: false } : {}),
    run: (s) => toggleWindow(s, opts.type),
    checked: (s) => isWindowOpen(s, opts.type),
  });
  services.keymap.add(opts.chords.map((chord) => ({ chord, command: opts.command })));
  addMenuItems('view', [cmd(opts.command, opts.menuOrder)]);
}
