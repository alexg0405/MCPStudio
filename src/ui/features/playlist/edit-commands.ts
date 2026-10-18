/** The playlist's tools and clip editing commands, with their shortcuts. */
import type { Services } from '@app/services';
import type { PlaylistTool } from '@app/stores/editor';
import { playlistCommands as pl } from './commands';

/** Playlist shortcuts only work while the playlist window has the focus. */
const PLAYLIST_FOCUS = { focus: ['playlist'] as const };

/** Each tool with its shortcut key and hint. */
const TOOLS: ReadonlyArray<{ tool: PlaylistTool; key: string; hint: string }> = [
  { tool: 'draw', key: 'P', hint: 'Click an empty spot to pick something to place there, drag a clip to move it' },
  { tool: 'paint', key: 'B', hint: 'Drag across a track to paint copies of the current pattern' },
  { tool: 'delete', key: 'D', hint: 'Click or drag over clips to delete them' },
  { tool: 'slice', key: 'C', hint: 'Click a clip to cut it in two' },
  { tool: 'select', key: 'E', hint: 'Drag a box around clips to select them' },
  { tool: 'comp', key: 'T', hint: 'Drag across a take to use that part of it in the comp (the comp track plays it)' },
];

/** Registers `playlist.tool.<name>` for each tool (and its key), then select, delete, copy, cut, paste and duplicate. */
export function registerPlaylistEditCommands(services: Services): void {
  const { commands, keymap } = services;
  const hasSelection = (s: Services): boolean => s.editor.getState().clipSelection.length > 0;
  for (const { tool, key, hint } of TOOLS) {
    commands.register({
      id: `playlist.tool.${tool}`,
      title: `Playlist ${tool} tool`,
      category: 'Playlist',
      hint,
      run: (s) => s.editor.getState().setPlaylist({ tool }),
      checked: (s) => s.editor.getState().playlist.tool === tool,
    });
    keymap.add([{ chord: key, command: `playlist.tool.${tool}`, when: PLAYLIST_FOCUS }]);
  }
  commands.register({
    id: 'playlist.selectAll',
    title: 'Select all clips',
    category: 'Playlist',
    hint: 'Select every clip in the playlist',
    run: pl.selectAll,
  });
  commands.register({
    id: 'playlist.deselect',
    title: 'Deselect clips',
    category: 'Playlist',
    hint: 'Clear the clip selection',
    run: pl.deselect,
  });
  commands.register({
    id: 'playlist.delete',
    title: 'Delete clips',
    category: 'Playlist',
    hint: 'Delete the selected clips',
    enabled: hasSelection,
    run: pl.deleteSelection,
  });
  commands.register({
    id: 'playlist.copy',
    title: 'Copy clips',
    category: 'Playlist',
    hint: 'Copy the selected clips',
    enabled: hasSelection,
    run: pl.copy,
  });
  commands.register({
    id: 'playlist.cut',
    title: 'Cut clips',
    category: 'Playlist',
    hint: 'Cut the selected clips',
    enabled: hasSelection,
    run: pl.cut,
  });
  commands.register({
    id: 'playlist.paste',
    title: 'Paste clips',
    category: 'Playlist',
    hint: 'Paste the copied clips after the selection (or at the song position)',
    enabled: (s) => !!s.editor.getState().clipClipboard?.length,
    run: pl.paste,
  });
  commands.register({
    id: 'playlist.duplicate',
    title: 'Duplicate clips',
    category: 'Playlist',
    hint: 'Copy the selected clips right after themselves',
    enabled: hasSelection,
    run: pl.duplicate,
  });
  keymap.add([
    { chord: 'Mod+A', command: 'playlist.selectAll', when: PLAYLIST_FOCUS },
    { chord: 'Escape', command: 'playlist.deselect', when: PLAYLIST_FOCUS },
    { chord: 'Delete', command: 'playlist.delete', when: PLAYLIST_FOCUS },
    { chord: 'Backspace', command: 'playlist.delete', when: PLAYLIST_FOCUS },
    { chord: 'Mod+C', command: 'playlist.copy', when: PLAYLIST_FOCUS },
    { chord: 'Mod+X', command: 'playlist.cut', when: PLAYLIST_FOCUS },
    { chord: 'Mod+V', command: 'playlist.paste', when: PLAYLIST_FOCUS },
    { chord: 'Mod+B', command: 'playlist.duplicate', when: PLAYLIST_FOCUS },
    { chord: 'Mod+D', command: 'playlist.duplicate', when: PLAYLIST_FOCUS },
  ]);
}
