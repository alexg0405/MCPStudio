import type { Services } from '@app/services';
import type { PlaylistTool } from '@app/stores/editor';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { Playlist } from './Playlist';
import { playlistCommands as pl } from './commands';

export function register(services: Services): void {
  // Markers, audio clip edits and recording add their entries to it.
  registerMenu({ id: 'playlist', label: 'Playlist', order: 44 });
  registerWindowType({
    type: 'playlist',
    title: () => 'Playlist - Arrangement',
    component: Playlist,
    defaultRect: (ws) => ({
      x: Math.round(ws.w * 0.02),
      y: Math.round(ws.h * 0.03),
      w: Math.round(ws.w * 0.96),
      h: Math.round(ws.h * 0.94),
    }),
    minSize: { w: 420, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.playlist',
    type: 'playlist',
    title: 'Playlist',
    hint: 'Show or hide the playlist',
    chords: ['F5', 'Alt+1'],
    menuOrder: 10,
  });

  const { commands, keymap } = services;
  // Follow playhead (FL's auto-scroll), for the playlist and the piano roll alike.
  commands.register<boolean | undefined>({
    id: 'view.followPlayhead',
    title: 'Follow playhead',
    category: 'View',
    hint: 'While playing, the playlist and piano roll scroll along so the playhead stays in view (scrolling by hand pauses it until the playhead is back on screen)',
    argsHint: 'true to turn it on, false to turn it off (leave out to switch it)',
    checked: (s) => s.prefs.getState().followPlayhead,
    run: (s, on) => s.prefs.getState().set({ followPlayhead: typeof on === 'boolean' ? on : !s.prefs.getState().followPlayhead }),
  });
  addMenuItems('view', [cmd('view.followPlayhead', 58)]);
  addMenuItems('playlist', [cmd('view.followPlayhead', 1), sep(2)]);

  const focus = { focus: ['playlist'] as const };
  const hasSel = (s: Services) => s.editor.getState().clipSelection.length > 0;
  for (const [tool, chord] of [
    ['draw', 'P'],
    ['paint', 'B'],
    ['delete', 'D'],
    ['slice', 'C'],
    ['select', 'E'],
  ] as [PlaylistTool, string][]) {
    commands.register({
      id: `playlist.tool.${tool}`,
      title: `Playlist ${tool} tool`,
      category: 'Playlist',
      run: (s) => s.editor.getState().setPlaylist({ tool }),
      checked: (s) => s.editor.getState().playlist.tool === tool,
    });
    keymap.add([{ chord, command: `playlist.tool.${tool}`, when: focus }]);
  }
  commands.register({ id: 'playlist.selectAll', title: 'Select all clips', category: 'Playlist', run: pl.selectAll });
  commands.register({ id: 'playlist.deselect', title: 'Deselect clips', category: 'Playlist', run: pl.deselect });
  commands.register({
    id: 'playlist.delete',
    title: 'Delete clips',
    category: 'Playlist',
    enabled: hasSel,
    run: pl.deleteSelection,
  });
  commands.register({ id: 'playlist.copy', title: 'Copy clips', category: 'Playlist', enabled: hasSel, run: pl.copy });
  commands.register({ id: 'playlist.cut', title: 'Cut clips', category: 'Playlist', enabled: hasSel, run: pl.cut });
  commands.register({
    id: 'playlist.paste',
    title: 'Paste clips',
    category: 'Playlist',
    enabled: (s) => !!s.editor.getState().clipClipboard?.length,
    run: pl.paste,
  });
  commands.register({
    id: 'playlist.duplicate',
    title: 'Duplicate clips',
    category: 'Playlist',
    enabled: hasSel,
    run: pl.duplicate,
  });
  keymap.add([
    { chord: 'Mod+A', command: 'playlist.selectAll', when: focus },
    { chord: 'Escape', command: 'playlist.deselect', when: focus },
    { chord: 'Delete', command: 'playlist.delete', when: focus },
    { chord: 'Backspace', command: 'playlist.delete', when: focus },
    { chord: 'Mod+C', command: 'playlist.copy', when: focus },
    { chord: 'Mod+X', command: 'playlist.cut', when: focus },
    { chord: 'Mod+V', command: 'playlist.paste', when: focus },
    { chord: 'Mod+B', command: 'playlist.duplicate', when: focus },
    { chord: 'Mod+D', command: 'playlist.duplicate', when: focus },
  ]);
}
