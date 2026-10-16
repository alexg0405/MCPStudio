import type { Services } from '@app/services';
import { canChooseOutput, findOutput, listOutputs } from '@app/audio-devices';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { ACCENTS, applyTheme, effectiveAccent, findAccent, findTheme, THEMES } from '../../theme/apply';
import { registerWindowType, toggleWindow } from '../../workspace/registry';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';
import { cleanUpUnusedAudio } from './storage-flow';

/** Settings: the sound output, MIDI, the typing keyboard, recording and help options in one window. */
export function register(services: Services): void {
  const { commands } = services;
  registerWindowType({
    type: 'settings',
    title: () => 'Settings',
    component: lazyWindow(() => import('./SettingsWindow'), (m) => m.SettingsWindow),
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 240), y: 40, w: 480, h: Math.min(600, ws.h - 80) }),
    minSize: { w: 340, h: 220 },
  });
  commands.register({
    id: 'options.settings',
    title: 'Settings…',
    category: 'Options',
    hint: 'Sound output (speakers or headphones), MIDI keyboards, the typing piano, recording, tooltips and storage',
    run: (s) => toggleWindow(s, 'settings'),
  });
  commands.register({
    id: 'storage.cleanUp',
    title: 'Clean up unused audio…',
    category: 'Options',
    hint: 'Free space: see how many audio files nothing uses any more, then remove them after you confirm',
    run: (s) => cleanUpUnusedAudio(s),
  });
  commands.register({
    id: 'storage.autoCleanup',
    title: 'Clean up unused audio by itself',
    category: 'Options',
    hint: 'When AGstudio is idle, remove audio nothing has used for a week (never while playing or exporting)',
    run: (s) => s.prefs.getState().set({ autoCleanup: !s.prefs.getState().autoCleanup }),
    checked: (s) => s.prefs.getState().autoCleanup,
  });
  commands.register<string>({
    id: 'options.outputDevice',
    title: 'Sound output device',
    category: 'Options',
    hint: 'Play through other speakers or headphones',
    argsHint: "part of the device's name (e.g. 'AirPods'), or 'default'",
    palette: false,
    run: async (s, query) => {
      const toast = s.session.getState().toast;
      if (!canChooseOutput()) return toast('This browser always plays through the system output.', 'error');
      const { outputs, complete } = await listOutputs();
      const out = findOutput(outputs, String(query ?? 'default'));
      if (!out) {
        const names = outputs.slice(1).map((o) => o.label);
        return toast(
          names.length
            ? `No output is called “${String(query)}”. There are: ${names.join(', ')}.`
            : complete
              ? 'Only the system default output is connected.'
              : 'The browser lists other outputs only after Options → Settings… → “Show all my devices”.',
          'error',
        );
      }
      s.prefs.getState().set({ outputDevice: out.id });
      toast(`Playing through ${out.label}`);
    },
  });
  // The look: theme and accent color (kept in prefs, applied to <html>).
  const look = () => {
    const p = services.prefs.getState();
    applyTheme(p.theme, p.accent, p.accentPicked);
  };
  services.prefs.subscribe(look);
  look();
  commands.register<string>({
    id: 'options.theme',
    title: 'Theme',
    category: 'Options',
    hint: 'How AGstudio looks: Black marble, White marble, Classic, Midnight, Graphite or Light',
    argsHint: THEMES.map((t) => `'${t.id}'`).join(', '),
    palette: false,
    run: (s, name) => {
      const theme = findTheme(String(name ?? ''));
      if (!theme) return s.session.getState().toast(`There is no theme called “${String(name)}”.`, 'error');
      s.prefs.getState().set({ theme });
    },
  });
  commands.register<string>({
    id: 'options.accent',
    title: 'Accent color',
    category: 'Options',
    hint: 'The highlight color of buttons, the playhead and selections',
    argsHint: ACCENTS.map((a) => `'${a.id}'`).join(', '),
    palette: false,
    run: (s, name) => {
      const accent = findAccent(String(name ?? ''));
      if (!accent) return s.session.getState().toast(`There is no accent color called “${String(name)}”.`, 'error');
      s.prefs.getState().set({ accent, accentPicked: true });
    },
  });
  services.keymap.add([{ chord: 'F10', command: 'options.settings' }]);
  addMenuItems('options', [
    cmd('options.settings', 0),
    cmd('storage.cleanUp', 0.3),
    {
      kind: 'dynamic',
      id: 'look',
      order: 0.2,
      entries: () => {
        const pr = services.prefs.getState();
        return [
          {
            label: 'Theme',
            run: () => {},
            children: THEMES.map((t) => ({
              label: t.label,
              hint: t.hint,
              checked: (findTheme(pr.theme) ?? 'marble') === t.id,
              run: () => services.commands.run('options.theme', t.id),
            })),
          },
          {
            label: 'Accent color',
            run: () => {},
            children: ACCENTS.map((a) => ({
              label: a.label,
              checked: effectiveAccent(pr.theme, pr.accent, pr.accentPicked) === a.id,
              run: () => services.commands.run('options.accent', a.id),
            })),
          },
        ];
      },
    },
    sep(0.5),
  ]);
  setWindowHelp('settings', {
    intro: 'Settings for this browser: where the sound plays, MIDI keyboards, the typing piano, recording and help.',
    moves: [
      ['Play through', 'Choose speakers, headphones or an audio interface'],
      ['▶ Test sound', 'A chime on the left, then the right'],
      ['MIDI input', 'Play from a MIDI keyboard (Chrome asks once)'],
      ['Typing piano', 'Your letter keys play the selected sound'],
      ['Recording', 'Metronome, count-in and note snapping'],
      ['Theme and accent', 'Dark, Midnight, Graphite or Light, in your color'],
      ['Storage', 'See what AGstudio keeps in this browser and clean up audio nothing uses'],
    ],
  });
}
