import type { Services } from '@app/services';
import { startPitchRenderer } from '@app/actions/pitch';
import { pitchState } from '@app/pitch/state';
import { addContextMenuItems } from '../../context-menus';
import { startKeyRouting } from '../../timeline/key-cursor/router';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { PITCH_EDITOR_WINDOW, registerPitchCommands } from './pitch-commands';

const WINDOW = PITCH_EDITOR_WINDOW;

/**
 * The Pitch editor: a piano grid of the notes found in a recorded clip, with the sung pitch line.
 * Drag notes to retune them, snap them all to the key, flatten drift, tame vibrato; the corrected
 * audio is made in the background and the clip plays it (app/actions/pitch.ts).
 */
export function register(services: Services): void {
  // Before the app's key handler is installed, so the notes' cursor keys reach it first (timeline/key-cursor/router.ts).
  startKeyRouting();
  registerWindowType({
    type: WINDOW,
    title: () => 'Pitch editor',
    component: lazyWindow(() => import('./PitchEditor'), (m) => m.PitchEditor),
    defaultRect: (ws) => ({ x: 70, y: 52, w: Math.min(980, Math.max(560, ws.w - 140)), h: Math.min(560, Math.max(340, ws.h - 110)) }),
    minSize: { w: 520, h: 280 },
  });
  registerWindowToggle(services, {
    command: 'pitchEditor.open',
    type: WINDOW,
    title: 'Pitch editor',
    hint: 'Correct the pitch of a sung audio clip note by note: snap to the key, retune notes, flatten drift, tame vibrato',
    chords: ['Alt+Shift+P'],
    menuOrder: 31,
  });
  setWindowHelp(WINDOW, {
    intro:
      'Shows the notes sung in an audio clip (blobs on a piano grid, with the pitch line as sung) so you can correct them. The corrected sound is made in the background and the clip plays it; your recording stays untouched.',
    moves: [
      ['Drag a note up or down', 'retunes it to the nearest semitone (hold Alt to move it by cents)'],
      ['Click / Shift+click / drag a box', 'selects notes; the sliders then act on the selection'],
      ['Snap all to key', 'pulls every note to the notes of the key (Strength sets how far)'],
      ['Drift / Vibrato sliders', 'flatten a note’s slow wandering, or scale its vibrato (0 % removes it)'],
      ['Transition slider', 'how fast the pitch glides to its new note (0 = hard tune)'],
      ['Split tool, S, M', 'cut a note in two where you click; M joins it with the next'],
      ['Right-click', 'a menu for the note: split, merge, snap, octave, reset'],
      ['Wheel / Ctrl+wheel / Alt+wheel', 'scroll, zoom in time, zoom the rows'],
      ['Delete', 'puts the selected notes back as sung'],
      ['Tab to the grid, then ← →', 'keyboard cursor: note to note (each is spoken), Enter selects, ↑ ↓ retune, ? says where you are'],
      ['B (or the A/B button)', 'switches between the corrected sound and your original recording so you can compare; nothing in the project changes'],
    ],
  });

  registerPitchCommands(services);

  // Right-click an audio clip, the Playlist menu, and Alt + double-click (the playlist calls the command).
  addContextMenuItems('playlist.clip', ({ clip }, s) =>
    clip.kind === 'audio'
      ? [
          {
            label: 'Pitch editor…',
            hint: 'Find the sung notes of this clip and correct their pitch (snap to the key, retune notes, flatten drift, tame vibrato)',
            onSelect: () => void s.commands.run('pitchEditor.openClip', { clip: clip.id }),
          },
        ]
      : [],
  );
  addMenuItems('playlist', [cmd('pitchEditor.openClip', 33)]);

  // The renderer that keeps the corrected audio up to date (created once, here).
  startPitchRenderer(services);
  // A new project, or a clip that is gone: the editor shows nothing rather than a ghost.
  services.history.onChange((change) => {
    const id = pitchState.getState().clipId;
    if (id && !change.next.playlist.clips[id]) pitchState.setState({ clipId: null, clip: null, phase: 'none', selected: [], message: '' });
  });
}
