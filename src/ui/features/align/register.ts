import type { Services } from '@app/services';
import { startAlignRenderer } from '@app/actions/align';
import { alignState } from '@app/align/state';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowType } from '../../workspace/registry';
import { setWindowHelp } from '../../workspace/window-help';
import { ALIGN_WINDOW, registerAlignCommands } from './align-commands';

/**
 * Vocal alignment: make doubles, backing vocals and ad-libs follow a lead clip (timing and, if asked, pitch), or tighten
 * a vocal to the grid. The settings are a record on each clip and the aligned sound is made in the background and played
 * by the clip (app/actions/align.ts); the original recording stays.
 */
export function register(services: Services): void {
  registerWindowType({
    type: ALIGN_WINDOW,
    title: () => 'Align vocals',
    component: lazyWindow(() => import('./AlignWindow'), (m) => m.AlignWindow),
    defaultRect: (ws) => ({ x: 90, y: 70, w: Math.min(460, Math.max(380, ws.w - 180)), h: Math.min(360, Math.max(300, ws.h - 140)) }),
    minSize: { w: 360, h: 280 },
  });
  setWindowHelp(ALIGN_WINDOW, {
    intro:
      'Lines up recorded vocals: a double, a backing vocal or an ad-lib follows the lead’s timing (and, if you ask, its pitch), or a vocal is snapped to the grid. The aligned sound is made in the background and the clip plays it; your recording stays untouched.',
    moves: [
      ['Select clips, pick the lead, press Align', 'moves the syllables of the selected clips onto the lead’s timing (one undo step)'],
      ['Tightness', '0 % only fixes big offsets, 100 % follows the lead syllable by syllable'],
      ['Pitch alignment', 'pulls the pitch towards the lead’s pitch contour (a harmony keeps its interval); 0 leaves the pitch alone'],
      ['Snap to the grid', 'moves each syllable start towards the nearest grid line by the strength you choose'],
      ['Aligned / Original', 'switches between the aligned sound and your original recording to compare; nothing in the project changes'],
      ['Remove', 'takes the alignment off the selected clips'],
      ['Pitch editor afterwards', 'tuning works on the aligned sound: align first, then tune'],
    ],
  });
  registerAlignCommands(services);

  // The clip's ▾ menu (right-click), and the Playlist menu / action search.
  addContextMenuItems('playlist.clip', ({ clip }, s) =>
    clip.kind === 'audio'
      ? [
          {
            label: 'Align to guide…',
            hint: 'Opens the Align window: make this clip (a double, a backing vocal) follow a lead clip in timing and pitch',
            onSelect: () => void s.commands.run('align.open', { clip: clip.id }),
          },
          {
            label: 'Tighten timing to the grid',
            hint: 'Moves the syllable starts of this vocal towards the nearest 1/16 grid line (80 %); open the Align window to choose the grid and strength',
            onSelect: () => void s.commands.run('align.tighten', { clips: [clip.id] }),
          },
          ...(clip.align
            ? [
                {
                  label: 'Remove alignment',
                  hint: 'Takes the alignment off this clip so it plays its own recording again',
                  onSelect: () => void s.commands.run('align.remove', { clips: [clip.id] }),
                },
              ]
            : []),
        ]
      : [],
  );
  addMenuItems('playlist', [cmd('align.open', 34), cmd('align.tighten', 35), cmd('align.remove', 36)]);

  // The renderer that keeps the aligned audio up to date (created once, here).
  startAlignRenderer(services);
  // A clip that is gone: the window shows the selection again rather than a ghost.
  services.history.onChange((change) => {
    const id = alignState.getState().windowClip;
    if (id && !change.next.playlist.clips[id]) alignState.setState({ windowClip: null });
  });
}
