import { formatChord } from '@core/commands/keymap';
import type { Services } from '@app/services';

/**
 * The keys of a command as the musician reads them on this computer ("Ctrl+Z" on Windows and Linux, "⌘Z" on a Mac), or
 * null when the command has no key. Used wherever a sentence names a shortcut, so no text hard-codes one system's keys.
 */
export function shortcutLabel(services: Pick<Services, 'keymap' | 'platform'>, commandId: string): string | null {
  const chord = services.keymap.chordsFor(commandId)[0];
  return chord ? formatChord(chord, services.platform) : null;
}
