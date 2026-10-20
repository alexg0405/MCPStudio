import type { Services } from '@app/services';
import { startCleanupRenderer } from '@app/actions/cleanup';
import { cleanupState } from '@app/cleanup/state';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { CLEANUP_WINDOW, registerCleanupCommands } from './cleanup-commands';

/**
 * Clean up vocal: noise reduction, breath control and mouth-click removal for a recorded audio clip, in one window with a
 * before/after listen. The cleaned audio is made in the background and the clip plays it (app/actions/cleanup-render.ts);
 * the recording stays. Reached from the clip ▾ menu, the Playlist menu, View, and the action search.
 */
export function register(services: Services): void {
  registerWindowType({
    type: CLEANUP_WINDOW,
    title: () => 'Clean up vocal',
    component: lazyWindow(() => import('./CleanupWindow'), (m) => m.CleanupWindow),
    defaultRect: (ws) => ({ x: 90, y: 60, w: Math.min(640, Math.max(420, ws.w - 180)), h: Math.min(620, Math.max(360, ws.h - 120)) }),
    minSize: { w: 380, h: 300 },
  });
  registerWindowToggle(services, {
    command: 'cleanup.open',
    type: CLEANUP_WINDOW,
    title: 'Clean up vocal',
    hint: 'Take background noise, breaths and lip smacks out of a recorded vocal clip, with a before/after listen',
    chords: [],
    menuOrder: 32,
  });
  setWindowHelp(CLEANUP_WINDOW, {
    intro:
      'Cleans up a recorded vocal clip: takes out background noise, tones down breaths and repairs mouth clicks. The cleaned sound is made in the background and the clip plays it; your recording stays untouched and Undo goes back.',
    moves: [
      ['Switch a section on', 'Noise reduction, Breaths and Mouth clicks each start with natural settings; the sliders then change them'],
      ['Drag on the strip', 'Chooses a stretch with only the room sound (no singing) to learn the noise from'],
      ['Click an orange box', 'Leaves that breath as it was recorded (click again to turn it down); the list below the sliders does the same'],
      ['Cleaned / Original', 'Switches between the cleaned sound and your recording as recorded, to compare; nothing in the project changes'],
      ['Hear what was removed', 'Plays only what was taken out: if you hear the voice in it, lower the reduction or the sensitivity'],
      ['Remove cleanup', 'The clip plays your recording again (one undo step)'],
    ],
  });

  registerCleanupCommands(services);

  // Right-click an audio clip (its ▾ menu) and the Playlist menu / action search.
  addContextMenuItems('playlist.clip', ({ clip }, s) =>
    clip.kind === 'audio'
      ? [
          {
            label: 'Clean up vocal…',
            hint: 'Take background noise, breaths and lip smacks out of this clip, with a before/after listen',
            onSelect: () => void s.commands.run('cleanup.openClip', { clip: clip.id }),
          },
        ]
      : [],
  );
  addMenuItems('playlist', [cmd('cleanup.openClip', 34)]);

  // The renderer that keeps the cleaned audio up to date (created once, here).
  startCleanupRenderer(services);
  // A new project, or a clip that is gone: the window shows nothing rather than a ghost.
  services.history.onChange((change) => {
    const id = cleanupState.getState().clipId;
    if (id && !change.next.playlist.clips[id]) cleanupState.setState({ clipId: null });
  });
}
