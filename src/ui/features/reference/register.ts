import type { Services } from '@app/services';
import { arrangeLikeReference, chooseReferenceFile, clearReference, matchLoudnessFromUi, matchTempoAndKey, toneDifferenceFromUi } from '@app/reference/actions';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';

/** Whether the project has a reference song (the commands that use it are enabled only then). */
const hasReference = (s: Services) => !!s.doc.getState().project.reference;

/**
 * Reference track matching: drop a song you own, see its tempo, key, parts, loudness and tone next to your
 * song's, and shape yours after it with one click each. Only measurements are used (see app/reference).
 * Studio has the same through `set_reference`, `match_reference` and `get_reference`.
 */
export function register(services: Services): void {
  registerReferenceWindow(services);
  registerReferenceCommands(services);
  registerReferenceMenus();
  registerReferenceHelp();
}

/** The Reference window and the command that opens it. */
function registerReferenceWindow(services: Services): void {
  registerWindowType({
    type: 'reference',
    title: () => 'Reference',
    component: lazyWindow(() => import('./ReferenceWindow'), (m) => m.ReferenceWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 330)), y: 48, w: Math.min(660, ws.w), h: Math.min(660, ws.h - 70) }),
    minSize: { w: 460, h: 320 },
  });
  registerWindowToggle(services, {
    command: 'reference.open',
    type: 'reference',
    title: 'Reference',
    hint: 'A song you own as a guide: its tempo, key, parts, loudness and tone next to your song’s, and one-click matches',
    chords: ['Alt+Shift+R'],
    menuOrder: 59,
  });
}

/** Choose, clear and the matches: tempo and key, arrangement, loudness and the tonal difference. */
function registerReferenceCommands({ commands }: Services): void {
  commands.register({
    id: 'reference.chooseFile',
    title: 'Choose a reference song…',
    category: 'Reference',
    hint: 'Pick a song you own as the reference. It is measured (tempo, key, parts, loudness, tone); its sound is never copied into your song',
    gesture: true,
    run: async (s) => void (await chooseReferenceFile(s)),
  });
  commands.register({
    id: 'reference.clear',
    title: 'Clear the reference',
    category: 'Reference',
    hint: 'Removes the reference song from this project (one undo step)',
    enabled: hasReference,
    run: (s) => void clearReference(s),
  });
  commands.register({
    id: 'reference.matchTempoKey',
    title: 'Match tempo and key to the reference',
    category: 'Reference',
    hint: 'Sets the tempo to the reference’s and moves your pitched notes into its key (drums stay). One undo step',
    ai: false,
    enabled: hasReference,
    run: (s) => {
      const r = matchTempoAndKey(s);
      s.session.getState().toast(r.message, r.error ? 'error' : 'info');
    },
  });
  commands.register({
    id: 'reference.arrange',
    title: 'Arrange like the reference',
    category: 'Reference',
    hint: 'Lays your patterns out with the reference’s section lengths and energy arc, with fills and transitions. Replaces the song’s arrangement; one undo step',
    ai: false,
    enabled: hasReference,
    run: (s) => {
      const r = arrangeLikeReference(s);
      s.session.getState().toast(r.message, r.error ? 'error' : 'info');
    },
  });
  commands.register({
    id: 'reference.matchLoudness',
    title: 'Match the loudness of the reference',
    category: 'Reference',
    hint: 'Listens to your mix and sets the faders and the master Limiter so it plays as loud (LUFS) as the reference. One undo step',
    ai: false,
    enabled: hasReference,
    run: (s) => matchLoudnessFromUi(s),
  });
  commands.register({
    id: 'reference.tone',
    title: 'Show the tonal difference',
    category: 'Reference',
    hint: 'Listens to your mix and shows the frequency bands more than 3 dB away from the reference, with a plain suggestion. Changes nothing',
    ai: false,
    enabled: hasReference,
    run: async (s) => {
      openWindow(s, 'reference');
      await toneDifferenceFromUi(s);
    },
  });
}

/** The Playlist and File menu entries and the action search entry. */
function registerReferenceMenus(): void {
  addMenuItems('playlist', [
    sep(60),
    cmd('reference.matchTempoKey', 61),
    cmd('reference.arrange', 62),
    cmd('reference.matchLoudness', 63),
    cmd('reference.tone', 64),
  ]);
  addMenuItems('file', [cmd('reference.chooseFile', 73)]);
  addActionProvider('reference', (s) => [
    {
      key: 'reference.set',
      label: 'Use a song as my reference',
      path: ['View', 'Reference'],
      hint: 'Measure a song you own (tempo, key, parts, loudness, tone) and shape your song after it',
      keywords: ['reference', 'like', 'sound like', 'match', 'song', 'compare', 'mastering', 'loudness', 'tempo', 'key'],
      run: () => openWindow(s, 'reference'),
    },
  ]);
}

/** What the window help panel says. */
function registerReferenceHelp(): void {
  setWindowHelp('reference', {
    intro: 'A song you own as a guide. It is measured, never copied: Studio and the buttons below use its tempo, key, parts, loudness and tone to shape your own song.',
    moves: [
      ['Drop a file / Choose', 'An MP3, AAC, WAV, FLAC or OGG you own (or a song of your music library)'],
      ['Parts and energy', 'The reference’s sections in bars next to yours: width is length, height is energy'],
      ['Match tempo and key', 'Your tempo becomes the reference’s; pitched notes move to its key, drums stay'],
      ['Arrange like the reference', 'Your patterns follow its section lengths and energy arc, with fills and transitions'],
      ['Match loudness', 'The master’s loudness (LUFS) goes to the reference’s'],
      ['Show the tonal difference', 'Bands where your mix is more than 3 dB off, with what to do. Changes nothing'],
      ['Studio', 'Ask “make it sound like my reference” and Studio does all of this in one undo step'],
    ],
  });
}
