import { loadGallery } from '@app/plugins/gallery';
import type { PluginRow } from '@app/plugins/types';
import type { Services } from '@app/services';
import { BUNDLE_EXTENSION } from '@core/plugin-bundle/manifest';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { chooseEmbeddedPlugins, importBundleFile, importDroppedBundles, installGalleryItem, offerMissingPlugins, reportFailure, sharePlugin } from './flows';
import { checkRow, deleteRow, disableRow, duplicateRow, enableRow, openFolderRow, renameRow, restoreRow } from './row-actions';

/**
 * My plugins: managing, sharing and installing your own plugins. The window lists them (with where the song uses each);
 * the commands do the same things by name, so menus, the action search, Studio and AI apps reach them too. Every install,
 * wherever it starts, shows what the plugin is and can do first, and waits for the musician's answer.
 */

/** A plugin of yours named by a command's argument: its id ("user.tape-stop") or its name ("Tape Stop"). */
function userRowNamed(s: Services, reference: unknown): PluginRow | null {
  const wanted = typeof reference === 'string' ? reference.trim().toLowerCase() : '';
  const mine = s.userPlugins.rows().filter((row) => row.source === 'user');
  const found = wanted ? mine.find((row) => row.id.toLowerCase() === wanted || row.name.toLowerCase() === wanted) : undefined;
  if (found) return found;
  if (wanted) s.session.getState().toast(`None of your plugins is called “${reference as string}”. My plugins lists them.`, 'error');
  else {
    openWindow(s, 'plugin-manager');
    s.session.getState().toast('Pick the plugin in the My plugins window.');
  }
  return null;
}

/** `{ plugin, name }`-style arguments, or just the plugin as a string. */
function pluginArgs(args: unknown): { plugin: unknown; name?: string; id?: string } {
  if (typeof args === 'string') return { plugin: args };
  const a = (args ?? {}) as { plugin?: unknown; name?: unknown; id?: unknown };
  return {
    plugin: a.plugin,
    ...(typeof a.name === 'string' ? { name: a.name } : {}),
    ...(typeof a.id === 'string' ? { id: a.id } : {}),
  };
}

/** A command that works on one plugin of yours, found by the argument. */
function onePlugin(run: (s: Services, row: PluginRow, extra: { name?: string; id?: string }) => Promise<void>) {
  return async (s: Services, args: unknown): Promise<void> => {
    const { plugin, ...extra } = pluginArgs(args);
    const row = userRowNamed(s, plugin);
    if (row) await run(s, row, extra);
  };
}

/** Bundles dropped on the window: any `.agplugin` file among them is checked and asked about (before anything else sees the drop). */
function installBundleDrops(s: Services): void {
  window.addEventListener(
    'drop',
    (event) => {
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.name.toLowerCase().endsWith(BUNDLE_EXTENSION));
      if (files.length === 0) return;
      event.preventDefault();
      void importDroppedBundles(s, files);
    },
    true,
  );
}

export function register(services: Services): void {
  registerWindowType({
    type: 'plugin-manager',
    title: () => 'My plugins',
    component: lazyWindow(() => import('./ManagerWindow'), (m) => m.ManagerWindow),
    defaultRect: (ws) => ({ x: Math.max(0, ws.w - 492), y: 40, w: 480, h: Math.min(640, ws.h - 80) }),
    minSize: { w: 340, h: 280 },
  });
  registerWindowToggle(services, {
    command: 'view.pluginManager',
    type: 'plugin-manager',
    title: 'My plugins',
    hint: 'Your own plugins: share one as a file, import one, duplicate, change the id, switch off, delete, and a gallery of examples',
    chords: ['Alt+Shift+U'],
    menuOrder: 63,
  });
  setWindowHelp('plugin-manager', {
    intro: 'Your own instruments and effects, written as code in the plugins/ folder. Share one as a single file, install one a friend sent, and keep them tidy.',
    moves: [
      ['Import a plugin…', `Choose a ${BUNDLE_EXTENSION} file: you see what it is and what it can do before it installs`],
      ['Drop a .agplugin file on AGstudio', 'The same as Import a plugin…'],
      ['Share… on a plugin', 'Saves it (with your presets for it) as one file to send to a friend'],
      ['Edit code', 'Opens its code in your code editor; every save hot-reloads it'],
      ['⋯ (or right-click) on a plugin', 'Duplicate, change the id, update from a newer file, check the code, switch off, delete'],
      ['Gallery: Install', 'Adds an example plugin (a tape stop, a bit crusher, an FM bell, a filter) to your plugins folder'],
      ['Trash: Restore', 'Brings back a plugin you deleted'],
    ],
  });
  registerCommands(services);
  addMenuItems('add', [cmd('plugins.import', 82)]);
  if (typeof window !== 'undefined') installBundleDrops(services);
  services.files.setUi({
    pluginsMissing: (info) => void offerMissingPlugins(services, info),
    chooseEmbeddedPlugins: () => chooseEmbeddedPlugins(services),
  });
}

function registerCommands(services: Services): void {
  const { commands } = services;
  commands.register<string | void>({
    id: 'plugins.import',
    title: 'Import a plugin…',
    category: 'Plugins',
    hint: `Install a plugin someone shared (a ${BUNDLE_EXTENSION} file), or an example from the gallery: you see what it can do and say yes before anything is installed`,
    argsHint: 'optional: the name of a gallery plugin to install (Tape Stop, Bit Crusher, FM Bell, Wobble Filter); without it a file chooser opens',
    // Without a name it opens a file chooser, which the browser allows right after a click: the studio asks for one.
    gesture: true,
    run: async (s, name) => {
      if (typeof name !== 'string' || !name.trim()) {
        await importBundleFile(s);
        return;
      }
      const item = (await loadGallery()).find((candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase() || candidate.id === name.trim());
      if (!item) s.session.getState().toast(`The gallery has no plugin called “${name}”. My plugins lists what it has.`, 'error');
      else await installGalleryItem(s, item);
    },
  });
  commands.register<unknown>({
    id: 'plugins.share',
    title: 'Share a plugin…',
    category: 'Plugins',
    hint: `Save one of your plugins, with your presets for it, as one ${BUNDLE_EXTENSION} file to send to a friend`,
    argsHint: 'the id or name of one of your plugins, e.g. "Tape Stop"',
    run: onePlugin((s, row) => sharePlugin(s, row.id)),
  });
  commands.register<unknown>({
    id: 'plugins.duplicate',
    title: 'Duplicate a plugin…',
    category: 'Plugins',
    hint: 'Make a copy of one of your plugins under a new name, to change without touching the original',
    argsHint: '{ plugin: id or name, name?: the copy’s name } (or just the plugin)',
    run: onePlugin((s, row, extra) => duplicateRow(s, row, extra.name)),
  });
  commands.register<unknown>({
    id: 'plugins.changeId',
    title: 'Change a plugin’s id…',
    category: 'Plugins',
    hint: 'Give one of your plugins a new id: the song, your presets and chains follow (one undo step for the song)',
    argsHint: '{ plugin: id or name, id: the new id like "user.my-plugin" }',
    run: onePlugin((s, row, extra) => renameRow(s, row, extra.id)),
  });
  commands.register<unknown>({
    id: 'plugins.disable',
    title: 'Switch a plugin off…',
    category: 'Plugins',
    hint: 'Stop loading one of your plugins without deleting it (its folder moves to plugins/_disabled)',
    argsHint: 'the id or name of one of your plugins',
    run: onePlugin((s, row) => disableRow(s, row)),
  });
  commands.register<unknown>({
    id: 'plugins.enable',
    title: 'Switch a plugin on',
    category: 'Plugins',
    hint: 'Load a plugin of yours that was switched off',
    argsHint: 'the id or name of the switched-off plugin',
    run: onePlugin((s, row) => enableRow(s, row)),
  });
  commands.register<unknown>({
    id: 'plugins.delete',
    title: 'Delete a plugin…',
    category: 'Plugins',
    hint: 'Move one of your plugins to plugins/_trash, where My plugins can bring it back',
    argsHint: 'the id or name of one of your plugins',
    run: onePlugin((s, row) => deleteRow(s, row)),
  });
  commands.register<unknown>({
    id: 'plugins.restore',
    title: 'Restore a deleted plugin',
    category: 'Plugins',
    hint: 'Bring back a plugin of yours from the trash (plugins/_trash)',
    argsHint: 'the id or folder name of the deleted plugin',
    run: async (s, reference) => {
      const wanted = typeof reference === 'string' ? reference.trim().toLowerCase() : '';
      const entry = s.userPlugins
        .trashRows()
        .find((row) => row.id?.toLowerCase() === wanted || row.folder.toLowerCase() === wanted || row.entry.toLowerCase() === wanted);
      if (entry) await restoreRow(s, entry);
      else {
        openWindow(s, 'plugin-manager');
        s.session.getState().toast(wanted ? `Nothing called “${reference as string}” is in the trash. My plugins lists what is.` : 'Pick the plugin in the Trash list of My plugins.', wanted ? 'error' : undefined);
      }
    },
  });
  commands.register<unknown>({
    id: 'plugins.check',
    title: 'Check a plugin’s code',
    category: 'Plugins',
    hint: 'Run the safety scan and the TypeScript check on one of your plugins and show what they find',
    argsHint: 'the id or name of one of your plugins',
    run: onePlugin((s, row) => checkRow(s, row)),
  });
  commands.register({
    id: 'plugins.openFolder',
    title: 'Open the plugins folder',
    category: 'Plugins',
    hint: 'Show the plugins folder in your file manager (needs the dev server)',
    run: (s) => void openFolderRow(s).catch((error: unknown) => reportFailure(s, error, 'open the folder')),
  });
}
