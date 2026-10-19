import type { Services } from '@app/services';
import {
  addMarkerAt,
  adjacentMarker,
  deleteMarker,
  describeMarker,
  findMarker,
  jumpTo,
  loopToNextMarker,
  renameMarkerTo,
  songPosition,
} from '@app/actions/markers';
import { markersSorted } from '@core/ops/markers';
import { formatBST, ticksPerBar } from '@core/time/ppq';
import { showFormDialog } from '../../controls/FormDialog';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep, type DynamicMenuEntry } from '../../shell/menus';
import { markerRename } from '../playlist/markers';

/** The marker a command means: its argument (id, name or number), else the one at or before the song position. */
function targetMarker(s: Services, ref: unknown) {
  if (ref !== undefined && ref !== null && ref !== '') return findMarker(s, typeof ref === 'object' ? (ref as { marker?: unknown }).marker : ref);
  const at = songPosition(s);
  const sorted = markersSorted(s.doc.getState().project);
  return [...sorted].reverse().find((m) => m.tick <= at) ?? sorted[0] ?? null;
}

/** Whether the project has any marker (the marker commands are enabled only then). */
const has = (s: Services) => Object.keys(s.doc.getState().project.playlist.markers).length > 0;

/** Whether a playlist window is open and showing, so a new marker can be named in place on its ruler. */
const visible = (s: Services) => !!Object.values(s.view.getState().windows).find((w) => w.type === 'playlist' && w.visible);

/** Where a new marker goes: an explicit tick, a bar (1 = the start), or else the song position. */
function markerTickFor(s: Services, where: { tick?: number; bar?: number }): number {
  if (typeof where.tick === 'number') return where.tick;
  if (typeof where.bar === 'number') return Math.max(0, (where.bar - 1) * ticksPerBar(s.doc.getState().project.transport.timeSig));
  return songPosition(s);
}

/**
 * Playlist markers: named song positions on the ruler (FL's Alt+T). Commands for adding, renaming,
 * deleting, jumping and looping (menus, the action search and the AI use them), and one action per
 * marker in the action search ("Jump to marker: Drop").
 */
export function register(services: Services): void {
  registerMarkerCommands(services);
  registerMarkerMenus(services);
  registerMarkerSearch();
}

/** Add, rename, delete, jump and loop commands, and the Alt+T key. */
function registerMarkerCommands({ commands, keymap }: Services): void {
  commands.register<{ name?: string; tick?: number; bar?: number } | string>({
    id: 'playlist.addMarker',
    title: 'Add marker at the song position',
    category: 'Playlist',
    hint: 'A named song position (“Verse”, “Drop”) on the playlist ruler: jump to it, loop between markers',
    argsHint: "optional: a name, or { name, bar } (bar 1 = the start) or { name, tick }",
    run: (s, args) => {
      const a = typeof args === 'string' ? { name: args } : (args ?? {});
      const tick = markerTickFor(s, a);
      const id = addMarkerAt(s, tick, a.name);
      // Typed in place, like FL; a name given with the command needs no prompt.
      if (!a.name && visible(s)) markerRename.setState({ id });
      const m = s.doc.getState().project.playlist.markers[id];
      if (m) s.session.getState().setHint(`Added marker ${describeMarker(s, m)}: type a name, or press Enter`);
    },
  });
  commands.register<{ marker?: string | number; name?: string }>({
    id: 'playlist.renameMarker',
    title: 'Rename marker…',
    category: 'Playlist',
    hint: 'Give a marker a new name (or double-click it on the ruler)',
    argsHint: '{ marker: its name, id or number, name: the new name } (without: the marker at the song position)',
    enabled: has,
    run: async (s, args) => {
      const m = targetMarker(s, args?.marker);
      if (!m) return;
      let name = args?.name;
      if (!name) {
        const values = await showFormDialog({
          title: 'Rename marker',
          message: `The marker at ${formatBST(m.tick, s.doc.getState().project.transport.timeSig)}.`,
          fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'Verse, Chorus, Drop…' }],
          values: { name: m.name },
          okLabel: 'Rename',
        });
        name = values ? String(values.name) : undefined;
      }
      if (name) renameMarkerTo(s, m.id, name);
    },
  });
  commands.register<string | number>({
    id: 'playlist.deleteMarker',
    title: 'Delete marker',
    category: 'Playlist',
    hint: 'Remove a marker from the ruler (the song itself doesn’t change)',
    argsHint: 'the marker: its name, id or number (without: the marker at the song position)',
    enabled: has,
    run: (s, ref) => {
      const m = targetMarker(s, ref);
      if (m) deleteMarker(s, m.id);
    },
  });
  commands.register<string | number>({
    id: 'playlist.jumpToMarker',
    title: 'Jump to marker',
    category: 'Playlist',
    hint: 'Set the song position to a marker (playback continues from there)',
    argsHint: 'the marker: its name, id or number (1 = the first)',
    palette: false,
    enabled: has,
    run: (s, ref) => {
      const m = findMarker(s, ref);
      if (m) jumpTo(s, m.tick);
      else s.session.getState().toast('There is no marker with that name.', 'error');
    },
  });
  for (const [id, dir, title] of [
    ['playlist.nextMarker', 1, 'Jump to the next marker'],
    ['playlist.previousMarker', -1, 'Jump to the previous marker'],
  ] as const) {
    commands.register({
      id,
      title,
      category: 'Playlist',
      hint: dir > 0 ? 'Move the song position to the next marker' : 'Move the song position back to the marker before',
      enabled: has,
      run: (s) => {
        const m = adjacentMarker(s, dir);
        if (m) jumpTo(s, m.tick);
        else s.session.getState().setHint(dir > 0 ? 'No marker after the song position' : 'No marker before the song position');
      },
    });
  }
  commands.register<string | number>({
    id: 'playlist.loopToNextMarker',
    title: 'Loop to the next marker',
    category: 'Playlist',
    hint: 'Loop the part between a marker and the next one (playback repeats it)',
    argsHint: 'the marker the loop starts at: its name, id or number (without: the marker at the song position)',
    enabled: has,
    run: (s, ref) => {
      const m = targetMarker(s, ref);
      if (m && loopToNextMarker(s, m.id)) s.session.getState().setHint(`Looping from ${m.name}`);
    },
  });
  keymap.add([{ chord: 'Alt+T', command: 'playlist.addMarker' }]);
}

/** The Playlist menu's Markers submenu and entries, read fresh each time the menu opens. */
function registerMarkerMenus(services: Services): void {
  const markerEntries = (): DynamicMenuEntry[] => {
    const list = markersSorted(services.doc.getState().project);
    if (list.length === 0)
      return [{ label: 'No markers yet: right-click the ruler or press Alt+T', disabled: true, run: () => {} }];
    return list.map((m) => ({
      label: describeMarker(services, m),
      run: () => {},
      children: [
        { label: 'Jump here', run: () => jumpTo(services, m.tick) },
        { label: 'Loop to the next marker', run: () => void loopToNextMarker(services, m.id) },
        { label: 'Rename…', run: () => void services.commands.run('playlist.renameMarker', { marker: m.id }) },
        { label: 'Delete', run: () => deleteMarker(services, m.id) },
      ],
    }));
  };
  addMenuItems('playlist', [
    cmd('playlist.addMarker', 10),
    cmd('playlist.nextMarker', 11),
    cmd('playlist.previousMarker', 12),
    cmd('playlist.loopToNextMarker', 13),
    { kind: 'submenu', id: 'markers', label: 'Markers', order: 14, items: () => [{ kind: 'dynamic', id: 'marker-list', order: 0, entries: markerEntries }] },
    sep(19),
  ]);
  addMenuItems('patterns', [sep(70), cmd('playlist.addMarker', 71)]);
}

/** One action per marker in the action search: jump to it, loop from it. */
function registerMarkerSearch(): void {
  addActionProvider('markers', (s) =>
    markersSorted(s.doc.getState().project).flatMap((m) => [
      {
        key: `marker:${m.id}`,
        label: `Jump to marker: ${m.name}`,
        path: ['Playlist', 'Markers'],
        hint: `Set the song position to ${describeMarker(s, m)}`,
        keywords: ['marker', 'go to', 'section'],
        run: () => jumpTo(s, m.tick),
      },
      {
        key: `marker-loop:${m.id}`,
        label: `Loop from marker: ${m.name}`,
        path: ['Playlist', 'Markers'],
        hint: 'Loop the part between this marker and the next one',
        keywords: ['marker', 'loop', 'section'],
        run: () => void loopToNextMarker(s, m.id),
      },
    ]),
  );
}
