import type { Services } from '@app/services';
import type { ListedProject } from '@core/projects/list';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';

/**
 * The project list: every project AGstudio remembers (files, autosaved work, projects with versions) with its tempo, key,
 * length and a picture of the arrangement. The File menu's recent list and Studio's `projects.open` share its data.
 */

/** The project a name means: an exact name first, then one that contains it. */
function projectNamed(items: readonly ListedProject[], name: string): ListedProject | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return items.find((i) => i.name.toLowerCase() === wanted) ?? items.find((i) => i.name.toLowerCase().includes(wanted)) ?? null;
}

export function register(services: Services): void {
  registerWindowType({
    type: 'projects',
    title: () => 'Projects',
    component: lazyWindow(() => import('./ProjectsWindow'), (m) => m.ProjectsWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round((ws.w - 720) / 2)), y: 48, w: Math.min(720, ws.w - 24), h: Math.min(520, ws.h - 80) }),
    minSize: { w: 320, h: 260 },
  });
  registerWindowToggle(services, {
    command: 'view.projects',
    type: 'projects',
    title: 'Projects',
    hint: 'Every project AGstudio remembers, with its tempo, key, length and a picture: open one, open a copy or see its versions',
    chords: ['Alt+Shift+O'],
    menuOrder: 63,
  });
  services.commands.register<string>({
    id: 'projects.open',
    title: 'Open a project by name',
    category: 'File',
    hint: 'Open one of your projects (a file, autosaved work or a project that only has versions) by its name',
    argsHint: 'the project’s name, as the Projects window and get_recent_projects list it',
    // It replaces the open project and may need to ask the browser for permission to read the file.
    gesture: true,
    palette: false,
    run: async (s, name) => {
      const item = projectNamed(await s.projects.list(), String(name ?? ''));
      if (!item) {
        s.session.getState().toast(`There is no project called “${String(name ?? '')}”. The Projects window lists them.`, 'error');
        return;
      }
      await s.projects.open(item);
    },
  });
  addMenuItems('file', [cmd('view.projects', 21)]);
}
