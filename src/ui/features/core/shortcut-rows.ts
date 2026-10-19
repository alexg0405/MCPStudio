/** What the Shortcuts window lists and how it changes your shortcuts (no React). */
import { formatChord, type Keymap, type Platform } from '@core/commands/keymap';
import type { CommandRegistry, CommandDef } from '@core/commands/registry';
import type { PrefsStore } from '@app/stores/prefs';
import type { Services } from '@app/services';

/** One command in the list, with its shortcuts and whether they are your own. */
export interface ShortcutRow {
  def: CommandDef<Services>;
  chords: string[];
  custom: boolean;
}

/**
 * The commands to list: those with a shortcut (all of them with `showAll`, or while searching), filtered by `query` (a
 * word of the title, category, hint or a shortcut) and sorted by category then title. Rebuilt on every render of the window
 * (a couple of hundred commands): the keymap changes in place.
 */
export function shortcutRows(commands: CommandRegistry<Services>, keymap: Keymap, platform: Platform, query: string, showAll: boolean): ShortcutRow[] {
  const words = query.trim().toLowerCase();
  const matches = (r: ShortcutRow) => {
    const text = `${r.def.title} ${r.def.category ?? ''} ${r.def.hint ?? ''} ${r.chords.map((c) => formatChord(c, platform)).join(' ')}`;
    return !words || text.toLowerCase().includes(words);
  };
  return commands
    .list()
    .map((def) => ({ def, chords: keymap.chordsFor(def.id), custom: keymap.isCustomized(def.id) }))
    .filter((r) => showAll || words || r.chords.length > 0 || r.custom)
    .filter(matches)
    .sort((a, b) => (a.def.category ?? '').localeCompare(b.def.category ?? '') || a.def.title.localeCompare(b.def.title));
}

/** Changes your shortcuts in the prefs: a list replaces a command's shortcuts, null puts back its built-in ones. */
export function setCustomShortcuts(prefs: PrefsStore, patch: Record<string, string[] | null>): void {
  const next = { ...prefs.getState().customKeys };
  for (const [id, chords] of Object.entries(patch)) {
    if (chords === null) delete next[id];
    else next[id] = chords;
  }
  prefs.getState().set({ customKeys: next });
}
