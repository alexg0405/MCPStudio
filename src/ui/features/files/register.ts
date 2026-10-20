import type { Services } from '@app/services';
import { recentFiles } from '@app/persistence/recent-files';
import { startFromTemplate, TEMPLATES } from '@app/template-list';
import { showProjectInfo } from './project-info';
import { PROJECT_FILE_EXTENSION } from '@core/io/project-file';
import { showDialog } from '../../controls/Dialog';
import { addMenuItems, cmd, sep, type DynamicMenuEntry } from '../../shell/menus';
import { applyDefaultLayout } from '../../workspace/layouts';
import { openWindow } from '../../workspace/registry';

/** New / Open / Save / Save As / Open Recent, the window title and project files dropped on the app. */
export const order = 5;

const RECENT_SHOWN = 8;

/** Whether no project operation (open, save, new) is running, so another can start. */
const idle = (s: Services) => s.files.store.getState().busy === null;

/** The project files: their dialogs, commands, keys and File menu, and (in a browser) the window title, file drops and the unsaved-changes warning. */
export function register(services: Services): void {
  registerFilesUi(services);
  registerFileCommands(services);
  registerFileKeys(services);
  registerFileMenu(services);

  if (typeof window === 'undefined') return; // Node tests
  installTitle(services);
  installFileDrops(services);
  if (!import.meta.env.DEV) installUnloadGuard(services);
}

/** What the project files ask the user: save changes first, and the layout a new project gets. */
function registerFilesUi(services: Services): void {
  const { files } = services;

  files.setUi({
    askUnsaved: (name) =>
      showDialog({
        title: 'Unsaved changes',
        message: `Save the changes to "${name}" first?`,
        detail: "If you don't save, your changes since the last save will be lost.",
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'discard', label: "Don't save", danger: true },
          { id: 'save', label: 'Save', primary: true },
        ],
        cancelId: 'cancel',
      }),
    defaultLayout: () => applyDefaultLayout(services),
  });
}

/** New, open, save, save as, project info, templates and open recent, as commands. */
function registerFileCommands({ commands }: Services): void {
  commands.register({
    id: 'file.new',
    title: 'New project',
    category: 'File',
    hint: 'Start a new project from the default template',
    enabled: idle,
    run: (s) => void s.files.newProject(),
  });
  commands.register({
    id: 'file.open',
    gesture: true,
    title: 'Open…',
    category: 'File',
    hint: `Open an AGstudio project (${PROJECT_FILE_EXTENSION})`,
    enabled: idle,
    run: (s) => void s.files.open(),
  });
  commands.register({
    id: 'file.save',
    gesture: true,
    title: 'Save',
    category: 'File',
    hint: 'Save the project to its file (asks where the first time)',
    enabled: idle,
    run: (s) => void s.files.save(),
  });
  commands.register({
    id: 'file.saveAs',
    gesture: true,
    title: 'Save as…',
    category: 'File',
    hint: 'Save the project to a new file',
    enabled: idle,
    run: (s) => void s.files.saveAs(),
  });

  commands.register({
    id: 'file.projectInfo',
    title: 'Project info…',
    category: 'File',
    hint: 'The title and author, and what is in the project (length, channels, notes…)',
    // A dialog; the song action sets the title and author, and the read tools say what is in the project.
    ai: false,
    run: (s) => void showProjectInfo(s),
  });
  commands.register<string>({
    id: 'file.newFromTemplate',
    title: 'New from template',
    category: 'File',
    hint: `Start a new project with a ready beat in a style (${TEMPLATES.map((t) => t.name.toLowerCase()).join(', ')})`,
    argsHint: TEMPLATES.map((t) => `'${t.id}'`).join(', '),
    palette: false,
    enabled: idle,
    run: (s, id) => void startFromTemplate(s, String(id ?? 'trap')),
  });
  commands.register<string>({
    id: 'file.openRecent',
    title: 'Open recent project',
    category: 'File',
    hint: 'Open one of the recently used projects by its name',
    gesture: true,
    argsHint: 'the project name, as listed under recent projects',
    // The File menu lists each recent project; this is for the AI studio.
    palette: false,
    enabled: idle,
    run: (s, name) => {
      const want = String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.agproj$/, '');
      const plain = (f: { name: string }) => f.name.replace(/\.agproj$/i, '').toLowerCase();
      const list = recentFiles();
      const hit = list.find((f) => plain(f) === want) ?? list.find((f) => want && plain(f).includes(want));
      if (!hit) {
        s.session.getState().toast(`There is no recent project called “${String(name ?? '')}”.`, 'error');
        return;
      }
      void s.files.openRecent(hit.key);
    },
  });
}

/** The file keys. */
function registerFileKeys({ keymap }: Services): void {
  keymap.add([
    // Chrome keeps ⌘N/Ctrl+N for a new window (it works in an installed app window), so Alt+N too.
    { chord: 'Mod+N', command: 'file.new' },
    { chord: 'Alt+N', command: 'file.new' },
    { chord: 'Mod+O', command: 'file.open' },
    { chord: 'Mod+S', command: 'file.save', when: { allowInInput: true } },
    { chord: 'Mod+Shift+S', command: 'file.saveAs', when: { allowInInput: true } },
  ]);
}

/** The File menu, with the template list and the recent projects read fresh each time it opens. */
function registerFileMenu(services: Services): void {
  const recentEntries = (): DynamicMenuEntry[] => {
    const list = recentFiles().slice(0, RECENT_SHOWN);
    const files: DynamicMenuEntry[] =
      list.length === 0
        ? [{ label: 'No recent projects', disabled: true, run: () => {} }]
        : list.map((f) => ({
            label: f.name.replace(/\.agproj$/i, ''),
            hint: `Open ${f.name} (last used ${new Date(f.usedAt).toLocaleString()})`,
            disabled: !idle(services),
            run: () => void services.files.openRecent(f.key),
          }));
    const all: DynamicMenuEntry = {
      label: 'All projects…',
      hint: 'The list of every project with its tempo, key, length and a picture; open one, open a copy or see its versions',
      run: () => openWindow(services, 'projects'),
    };
    return [{ label: 'Open recent', hint: 'The projects you used lately', children: [...files, all], run: () => {} }];
  };
  addMenuItems('file', [
    cmd('file.new', 10),
    {
      kind: 'dynamic',
      id: 'templates',
      order: 12,
      entries: () => [
        {
          label: 'New from template',
          run: () => {},
          children: TEMPLATES.map((t) => ({
            label: t.name,
            hint: t.description,
            disabled: !idle(services),
            run: () => void startFromTemplate(services, t.id),
          })),
        },
      ],
    },
    cmd('file.open', 20),
    sep(22),
    { kind: 'dynamic', id: 'recent-files', order: 24, entries: recentEntries },
    sep(30),
    cmd('file.save', 40),
    cmd('file.saveAs', 50),
    sep(52),
    cmd('file.projectInfo', 54),
  ]);
}


/** "● Song – AGstudio" while there are unsaved changes. */
function installTitle(s: Services): void {
  const update = () => {
    const { name } = s.files.store.getState();
    document.title = `${s.history.status().dirty ? '● ' : ''}${name} – AGstudio`;
  };
  s.files.store.subscribe(update);
  s.history.onStatus(update);
  update();
}

/**
 * A project file dropped anywhere opens it. Other drops that no editor took (stray audio files) are
 * swallowed: by default the browser would navigate to the file and leave the app.
 */
function installFileDrops(s: Services): void {
  window.addEventListener('dragover', (e) => {
    // An editor that accepts the drop has already handled it.
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    const index = [...dt.files].findIndex((f) => f.name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION));
    if (index < 0) {
      if (dt.files.length > 0) s.session.getState().toast('Drop audio files on the channel rack or the playlist.');
      return;
    }
    const file = dt.files[index] as File;
    // Chrome hands out a file handle for dropped files, so Save writes back to the same file.
    const item = [...dt.items].filter((i) => i.kind === 'file')[index] as
      (DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }) | undefined;
    const handle = item?.getAsFileSystemHandle?.() ?? Promise.resolve(null);
    void handle
      .catch(() => null)
      .then((h) => s.files.openFile(file, h?.kind === 'file' ? (h as FileSystemFileHandle) : null));
  });
}

/** Production builds warn before closing a tab with unsaved changes (autosave keeps a copy too). */
function installUnloadGuard(s: Services): void {
  window.addEventListener('beforeunload', (e) => {
    if (!s.history.status().dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
