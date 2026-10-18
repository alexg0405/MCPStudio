import type { Services } from '@app/services';
import { clearSlotAt, fillFromClips, fillFromPatterns } from '@app/launcher/edit';
import { isLaunchQuantize, QUANTIZE_LABELS } from '@core/launcher/grid';
import { LAUNCH_QUANTIZES, type LaunchQuantize } from '@core/model/types';
import { addLaunchTrack, addScene, setLauncherQuantize } from '@core/ops/launcher';
import { addContextMenuItems } from '../../context-menus';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { sendToLauncherEntry } from './menus';

/** 1-based track and scene numbers, as a person (or the Studio) counts them. */
interface Place {
  track: number;
  scene: number;
}

const placeOf = (args: unknown): Place | null => {
  const a = args as Partial<Place> | undefined;
  return a && Number.isInteger(a.track) && Number.isInteger(a.scene) && (a.track as number) >= 1 && (a.scene as number) >= 1
    ? { track: a.track as number, scene: a.scene as number }
    : null;
};

/**
 * The clip launcher (Performance mode): a grid of slots that point at patterns and audio clips, launched live in
 * time with the song, with a record that writes the jam to the playlist. The model is `project.launcher`; the live
 * state is `services.launcher`.
 */
export function register(services: Services): void {
  const { commands, keymap } = services;
  registerWindowType({
    type: 'launcher',
    title: () => 'Clip launcher',
    component: lazyWindow(() => import('./LauncherWindow'), (m) => m.LauncherWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 450)), y: 50, w: Math.min(900, ws.w), h: Math.min(560, ws.h - 70) }),
    minSize: { w: 420, h: 280 },
  });
  registerWindowToggle(services, {
    command: 'launcher.open',
    type: 'launcher',
    title: 'Clip launcher',
    hint: 'Perform with your patterns and audio clips: a grid of slots you launch live, in time with the song, and record onto the playlist',
    chords: ['Alt+Shift+L'],
    menuOrder: 61,
  });

  commands.register<Place | undefined>({
    id: 'launcher.launch',
    title: 'Launch a clip launcher slot',
    category: 'Launcher',
    hint: 'Press a slot of the clip launcher by its track and scene number: it starts on the next quantize boundary (its mode decides what a press does)',
    argsHint: '{ track: 1-based column, scene: 1-based row }',
    palette: false,
    run: (s, args) => {
      const p = placeOf(args);
      if (!p) return void s.session.getState().toast('Say which slot: a track and a scene number.', 'error');
      s.launcher.pressAt(p.track - 1, p.scene - 1);
    },
  });
  commands.register<{ scene?: number } | undefined>({
    id: 'launcher.launchScene',
    title: 'Launch a scene',
    category: 'Launcher',
    hint: 'Launch a whole row of the clip launcher: every track’s slot in that scene starts together',
    argsHint: '{ scene: 1-based row }',
    palette: false,
    run: (s, args) => {
      if (!args || !Number.isInteger(args.scene) || (args.scene as number) < 1) return void s.session.getState().toast('Say which scene (a number from 1).', 'error');
      s.launcher.launchSceneAt((args.scene as number) - 1);
    },
  });
  commands.register<{ track?: number } | undefined>({
    id: 'launcher.stopTrack',
    title: 'Stop a launcher track',
    category: 'Launcher',
    hint: 'Stop what one track of the clip launcher plays, at the next boundary',
    argsHint: '{ track: 1-based column }',
    palette: false,
    run: (s, args) => {
      if (!args || !Number.isInteger(args.track) || (args.track as number) < 1) return void s.session.getState().toast('Say which track (a number from 1).', 'error');
      s.launcher.stopTrackAt((args.track as number) - 1);
    },
  });
  commands.register<{ now?: boolean } | undefined>({
    id: 'launcher.stopAll',
    title: 'Stop all launcher slots',
    category: 'Launcher',
    hint: 'Stop everything the clip launcher plays, at the next boundary (or right away with now: true)',
    argsHint: 'optional { now: true } to stop at once instead of at the next boundary',
    run: (s, args) => s.launcher.stopAll(args?.now === true),
  });
  commands.register({
    id: 'launcher.recordPerformance',
    title: 'Record performance to playlist',
    category: 'Launcher',
    hint: 'Keep what you launch from the next bar; press again to end at a bar and put it on the playlist as clips (one undo step)',
    run: (s) => s.launcher.toggleRecording(),
    checked: (s) => s.launcher.store.getState().recording,
  });
  commands.register<{ quantize?: string } | string | undefined>({
    id: 'launcher.setQuantize',
    title: 'Launcher quantize',
    category: 'Launcher',
    hint: 'When launches and stops take effect: immediately, or on the next beat, bar, 2 bars or 4 bars',
    argsHint: `'${LAUNCH_QUANTIZES.join("' | '")}'`,
    palette: false,
    run: (s, args) => {
      const q = typeof args === 'string' ? args : args?.quantize;
      if (!isLaunchQuantize(q)) return void s.session.getState().toast(`Choose one of: ${LAUNCH_QUANTIZES.map((x) => QUANTIZE_LABELS[x]).join(', ')}.`, 'error');
      s.history.transact('Launcher quantize', (d) => setLauncherQuantize(d, q as LaunchQuantize));
    },
  });
  commands.register({
    id: 'launcher.addScene',
    title: 'Add a launcher scene',
    category: 'Launcher',
    hint: 'Add a row to the bottom of the clip launcher',
    run: (s) => void s.history.transact('Add launcher scene', (d) => void addScene(d)),
  });
  commands.register({
    id: 'launcher.addTrack',
    title: 'Add a launcher track',
    category: 'Launcher',
    hint: 'Add a column to the clip launcher: a track plays one slot at a time',
    run: (s) => void s.history.transact('Add launcher track', (d) => void addLaunchTrack(d)),
  });
  commands.register({
    id: 'launcher.fromSelection',
    title: 'Send selected clips to the clip launcher',
    category: 'Launcher',
    hint: 'Put the pattern and audio clips selected in the playlist into free slots of the clip launcher',
    // Works on the playlist selection.
    ai: false,
    enabled: (s) => s.editor.getState().clipSelection.length > 0,
    run: (s) => {
      const r = fillFromClips(s, s.editor.getState().clipSelection);
      openWindow(s, 'launcher');
      s.session.getState().toast(r.placed ? `Sent ${r.placed} clip${r.placed === 1 ? '' : 's'} to the clip launcher.` : 'Nothing to send: automation clips can’t be launched.', r.placed ? 'info' : 'error');
    },
  });
  commands.register({
    id: 'launcher.fromPatterns',
    title: 'Put my patterns in the clip launcher',
    category: 'Launcher',
    hint: 'Fill the first track of the clip launcher with the project’s patterns, one per scene',
    run: (s) => {
      const n = fillFromPatterns(s);
      openWindow(s, 'launcher');
      s.session.getState().toast(`Put ${n} pattern${n === 1 ? '' : 's'} in the clip launcher.`);
    },
  });

  // The window's keyboard (a window with the focus): arrows move, Enter launches, numbers launch scenes.
  commands.register<{ dx: number; dy: number }>({
    id: 'launcher.cursor',
    title: 'Move the clip launcher cursor',
    category: 'Launcher',
    hint: 'Move the highlighted slot of the clip launcher',
    palette: false,
    // The keyboard cursor of the window: Studio launches by track and scene number.
    ai: false,
    run: (s, a) => {
      const c = s.launcher.store.getState().cursor;
      s.launcher.setCursor(c.track + a.dx, c.scene + a.dy);
    },
  });
  commands.register({
    id: 'launcher.launchCursor',
    title: 'Launch the highlighted slot',
    category: 'Launcher',
    hint: 'Press the highlighted slot of the clip launcher',
    palette: false,
    ai: false,
    run: (s) => {
      const c = s.launcher.store.getState().cursor;
      s.launcher.pressAt(c.track, c.scene);
    },
  });
  commands.register<{ scene: number }>({
    id: 'launcher.sceneKey',
    title: 'Launch scene (number key)',
    category: 'Launcher',
    hint: 'Launch the scene with that number (1–9, 0 is scene 10) while the clip launcher has the focus',
    palette: false,
    ai: false,
    run: (s, a) => s.launcher.launchSceneAt(a.scene - 1),
  });
  commands.register({
    id: 'launcher.stopCursorTrack',
    title: 'Stop the highlighted track',
    category: 'Launcher',
    hint: 'Stop what the highlighted track of the clip launcher plays',
    palette: false,
    ai: false,
    run: (s) => s.launcher.stopTrackAt(s.launcher.store.getState().cursor.track),
  });
  commands.register({
    id: 'launcher.clearCursor',
    title: 'Clear the highlighted slot',
    category: 'Launcher',
    hint: 'Empty the highlighted slot of the clip launcher (the pattern or audio is not deleted)',
    palette: false,
    ai: false,
    run: (s) => {
      const c = s.launcher.store.getState().cursor;
      const t = s.launcher.trackAt(c.track);
      const sc = s.launcher.sceneAt(c.scene);
      if (t && sc) clearSlotAt(s, t, sc);
    },
  });
  const focus = { focus: ['launcher'] } as const;
  keymap.add([
    { chord: 'ArrowLeft', command: 'launcher.cursor', args: { dx: -1, dy: 0 }, repeat: true, when: focus },
    { chord: 'ArrowRight', command: 'launcher.cursor', args: { dx: 1, dy: 0 }, repeat: true, when: focus },
    { chord: 'ArrowUp', command: 'launcher.cursor', args: { dx: 0, dy: -1 }, repeat: true, when: focus },
    { chord: 'ArrowDown', command: 'launcher.cursor', args: { dx: 0, dy: 1 }, repeat: true, when: focus },
    { chord: 'Enter', command: 'launcher.launchCursor', when: focus },
    { chord: 'Period', command: 'launcher.stopCursorTrack', when: focus },
    { chord: 'Escape', command: 'launcher.stopAll', when: focus },
    { chord: 'Delete', command: 'launcher.clearCursor', when: focus },
    { chord: 'Backspace', command: 'launcher.clearCursor', when: focus },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => ({ chord: String(n), command: 'launcher.sceneKey', args: { scene: n === 0 ? 10 : n }, when: focus })),
  ]);

  addMenuItems('view', [cmd('launcher.fromSelection', 62), cmd('launcher.fromPatterns', 63), cmd('launcher.recordPerformance', 64), sep(65)]);
  addContextMenuItems('playlist.clip', ({ clip }, s) => (clip.kind === 'automation' ? [] : [sendToLauncherEntry(s, clip.id)]));
  addActionProvider('launcher', (s) => [
    {
      key: 'launcher.recordPerformance',
      label: 'Record performance to playlist',
      path: ['View', 'Clip launcher'],
      hint: 'Record what you launch in the clip launcher and put it on the playlist as an arrangement',
      keywords: ['jam', 'perform', 'performance', 'record', 'launch', 'clips', 'session', 'scenes', 'arrangement'],
      run: () => {
        openWindow(s, 'launcher');
        void s.commands.run('launcher.recordPerformance');
      },
    },
    {
      key: 'launcher.fromSelection',
      label: 'Send selected clips to the clip launcher',
      path: ['View', 'Clip launcher'],
      hint: 'Put the playlist’s selected clips in the clip launcher to launch them live',
      keywords: ['performance mode', 'jam', 'perform', 'launch', 'scenes', 'clips', 'session', 'ableton'],
      disabled: s.editor.getState().clipSelection.length === 0,
      run: () => void s.commands.run('launcher.fromSelection'),
    },
  ]);
  setWindowHelp('launcher', {
    intro: 'Perform with your patterns and audio clips. Each column is a track that plays one slot at a time; press a slot or a scene and it starts in time with the song.',
    moves: [
      ['Drag a pattern from the Browser onto a slot', 'The slot plays that pattern (it points at it: edits to the pattern are heard)'],
      ['Press a slot', 'Launch it on the next boundary (the “Launch on” box); a new slot replaces the one playing in its track'],
      ['Scene button (or a number key)', 'Launch every slot of that row together'],
      ['Stop button under a track (or the period key)', 'Stop that track at the next boundary; Stop all stops everything'],
      ['Right-click a slot', 'Mode (trigger, toggle, gate, retrigger), loop, quantize, follow action, name, colour, clear'],
      ['Arrow keys, Enter', 'Move the highlight and launch the highlighted slot'],
      ['Grip on a slot', 'Drag to move it (hold Alt to copy)'],
      ['Right-click a track name', 'Rename it, or let it take over a playlist track while it plays'],
      ['Record performance', 'Keeps what you launch; press again and it goes on the playlist as clips (one undo)'],
      ['Pads…', 'Link a Launchpad or any pad controller: its pads launch slots and light up with their state'],
    ],
  });
}
