import type { Services } from '@app/services';
import { formatChord } from '@core/commands/keymap';
import { getActionProviders, type ActionEntry } from '../../shell/actions';
import { getMenuItems, getMenus, type DynamicMenuEntry, type MenuItem } from '../../shell/menus';

/** Never listed: the search itself. */
const HIDDEN = new Set(['help.palette']);

/**
 * Everything the action search offers, gathered when it opens: every menu (submenus and dynamic
 * entries such as recent files included, with their menu path), what features add, then the commands
 * no menu shows, under their category.
 */
export function collectActions(s: Services): ActionEntry[] {
  const { commands, keymap, platform } = s;
  const out: ActionEntry[] = [];
  const seen = new Set<string>();
  const add = (e: ActionEntry) => {
    if (seen.has(e.key)) return;
    seen.add(e.key);
    out.push(e);
  };
  const chordOf = (id: string) => {
    const c = keymap.chordsFor(id)[0];
    return c ? formatChord(c, platform) : undefined;
  };
  const fromCommand = (id: string, path: string[], label?: string, args?: unknown) => {
    const def = commands.get(id);
    if (!def || HIDDEN.has(id)) return;
    const plain = args === undefined;
    add({
      key: plain ? `cmd:${id}` : `cmd:${id}:${JSON.stringify(args)}`,
      label: label ?? def.title,
      path,
      ...(def.hint ? { hint: def.hint } : {}),
      ...(plain && chordOf(id) ? { chord: chordOf(id)! } : {}),
      ...(def.checked ? { checked: commands.isChecked(id) } : {}),
      disabled: !commands.isEnabled(id),
      run: () => void commands.run(id, args),
    });
  };
  const walkEntries = (entries: DynamicMenuEntry[], path: string[]) => {
    for (const e of entries) {
      if (e.children) {
        walkEntries(e.children, [...path, e.label]);
        continue;
      }
      add({
        key: `menu:${[...path, e.label].join(' › ')}`,
        label: e.label,
        path,
        ...(e.hint && e.hint !== e.label ? { hint: e.hint } : {}),
        ...(e.checked !== undefined ? { checked: e.checked } : {}),
        disabled: !!e.disabled,
        run: e.run,
      });
    }
  };
  const walk = (items: MenuItem[], path: string[]) => {
    for (const item of items) {
      if (item.kind === 'command') fromCommand(item.command, path, item.label, item.args);
      else if (item.kind === 'dynamic') walkEntries(item.entries(), path);
      else if (item.kind === 'submenu') walk(item.items(), [...path, item.label]);
    }
  };
  for (const m of getMenus()) walk(getMenuItems(m.id), [m.label]);
  for (const provider of getActionProviders()) for (const e of provider(s)) add(e);

  // Commands no menu shows. One whose every key binding passes arguments needs them: leave it out.
  const needsArgs = new Map<string, boolean>();
  for (const b of keymap.all()) needsArgs.set(b.command, (needsArgs.get(b.command) ?? true) && b.args !== undefined);
  for (const def of commands.list()) {
    if (def.palette === false || needsArgs.get(def.id)) continue;
    fromCommand(def.id, [def.category ?? 'Other']);
  }
  return out;
}
