import type { Services } from '@app/services';
import { versionTitle } from '@core/versions/types';
import { showFormDialog } from '../../controls/FormDialog';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';

/**
 * Versions: save points of the project. The window lists them (listen, restore, open as a copy, keep, delete); the
 * commands save a named version and bring one back, by name, so Studio and AI apps can use them too.
 */

/** The name asked for, or null when the musician cancelled. */
async function askVersionName(): Promise<string | null> {
  const values = await showFormDialog({
    title: 'Save a version',
    message: 'Keep the song as it is now. A named version is kept forever, so you can always come back to it.',
    fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'Before vocals' }],
    values: { name: '' },
    okLabel: 'Save version',
  });
  return values ? String(values.name).trim() : null;
}

/** The version a command's argument names, or a toast saying there is none. */
async function versionNamed(s: Services, reference: unknown) {
  const wanted = typeof reference === 'string' ? reference.trim() : '';
  if (!wanted) {
    openWindow(s, 'versions');
    s.session.getState().toast('Pick the version in the Versions window.');
    return null;
  }
  const record = await s.versions.find(wanted);
  if (!record) s.session.getState().toast(`There is no version called “${wanted}”. The Versions window lists them.`, 'error');
  return record;
}

export function register(services: Services): void {
  registerWindowType({
    type: 'versions',
    title: () => 'Versions',
    component: lazyWindow(() => import('./VersionsWindow'), (m) => m.VersionsWindow),
    defaultRect: (ws) => ({ x: Math.max(0, ws.w - 412), y: 40, w: 400, h: Math.min(580, ws.h - 80) }),
    minSize: { w: 300, h: 260 },
  });
  registerWindowToggle(services, {
    command: 'view.versions',
    type: 'versions',
    title: 'Versions',
    hint: 'Save points of the song: listen to an earlier version, restore it or open it as a copy',
    chords: ['Alt+Shift+V'],
    menuOrder: 62,
  });
  registerVersionCommands(services);
  addMenuItems('file', [cmd('versions.save', 51), cmd('view.versions', 51.5)]);
}

function registerVersionCommands({ commands }: Services): void {
  commands.register<string | undefined>({
    id: 'versions.save',
    title: 'Save a version…',
    category: 'File',
    hint: 'Keep the song as it is now as a named version that is kept forever (you can restore it later)',
    argsHint: 'optional: a name for the version, e.g. "Before vocals"',
    run: async (s, name) => {
      const given = typeof name === 'string' ? name.trim() : null;
      const chosen = given ?? (await askVersionName());
      if (chosen === null) return;
      const record = await s.versions.saveNamed(chosen);
      if (record) s.session.getState().toast(`Saved the version “${versionTitle(record)}”.`);
    },
  });
  commands.register<string>({
    id: 'versions.restore',
    title: 'Restore a version',
    category: 'File',
    hint: 'Put the song back to a saved version: one undo step, and the song as it is now is kept as a version first',
    argsHint: 'the version’s name (or part of it), or "latest" for the newest one',
    // It replaces the whole song, so when Studio or an AI app asks, the musician confirms with one click.
    gesture: true,
    palette: false,
    run: async (s, reference) => {
      const record = await versionNamed(s, reference);
      if (record) await s.versions.restore(record);
    },
  });
  commands.register<string>({
    id: 'versions.openCopy',
    title: 'Open a version as a copy',
    category: 'File',
    hint: 'Open a saved version as a new unsaved project and leave the song you have open alone',
    argsHint: 'the version’s name (or part of it), or "latest"',
    gesture: true,
    palette: false,
    run: async (s, reference) => {
      const record = await versionNamed(s, reference);
      if (record) await s.versions.openAsCopy(record);
    },
  });
  commands.register<string>({
    id: 'versions.keep',
    title: 'Keep a version forever',
    category: 'File',
    hint: 'Make sure a version is never tidied away, however old it gets',
    argsHint: 'the version’s name (or part of it), or "latest"',
    palette: false,
    run: async (s, reference) => {
      const record = await versionNamed(s, reference);
      if (!record) return;
      await s.versions.setPinned(record, true);
      s.session.getState().toast(`“${versionTitle(record)}” is kept forever.`);
    },
  });
}
