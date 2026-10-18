import type { Services } from '@app/services';
import { addSampleFolder, canPickFolders, loadSampleFolders } from '@app/persistence/sample-folders';
import { makeKitFromRows, stopPreviewRow } from '@app/samples/actions';
import { addActionProvider } from '../../shell/actions';
import { addBrowserSection } from '../../shell/Browser';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { SampleFoldersSection } from './SampleFolders';

/** Your sample folders: the folder list in the browser panel and the sample browser window (analysis, search, audition). */
export function register(services: Services): void {
  addBrowserSection({
    id: 'sample-folders',
    title: 'Sample folders',
    icon: 'folder',
    order: 25,
    component: SampleFoldersSection,
  });
  registerWindowType({
    type: 'samples',
    title: () => 'Sample browser',
    component: lazyWindow(() => import('./SampleBrowserWindow'), (m) => m.SampleBrowserWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 490)), y: 36, w: Math.min(980, ws.w), h: Math.min(640, ws.h - 50) }),
    minSize: { w: 520, h: 320 },
  });
  registerWindowToggle(services, {
    command: 'samples.open',
    type: 'samples',
    title: 'Sample browser',
    hint: 'Your sample folders, sorted out: search and filter by type, tempo and key, hear any sound, drag it into the project',
    chords: ['Alt+B'],
    menuOrder: 58,
  });
  const { commands } = services;
  commands.register({
    id: 'samples.addFolder',
    title: 'Add a sample folder…',
    category: 'Samples',
    hint: 'Pick a folder of your own sounds (WAV, AIFF, FLAC, MP3…); the sample browser lists and sorts them',
    gesture: true,
    enabled: () => canPickFolders(),
    run: async () => void (await addSampleFolder()),
  });
  commands.register({
    id: 'samples.reanalyze',
    title: 'Analyze the sample folders again',
    category: 'Samples',
    hint: 'Work out the type, tempo and key of every sample again (after an update, or when a result looks wrong)',
    run: (s) => void s.sampleBrowser.reanalyze(),
  });
  commands.register({
    id: 'samples.stopPreview',
    title: 'Stop the sample preview',
    category: 'Samples',
    hint: 'Stop the sound that is playing from the sample browser',
    run: (s) => stopPreviewRow(s),
  });
  commands.register({
    id: 'samples.makeKit',
    title: 'Make a drum kit from the selected samples',
    category: 'Samples',
    hint: 'A Drum Pads channel from the one-shots selected in the sample browser: kick on pad 1, snare on 3, clap on 4, hats on 7 and 9',
    ai: false,
    enabled: (s) => s.sampleBrowser.store.getState().selected.length > 0,
    run: async (s) => {
      const { selected, rows } = s.sampleBrowser.store.getState();
      const chosen = rows.filter((r) => selected.includes(r.id));
      const res = await makeKitFromRows(s, chosen);
      s.session.getState().toast(res.channelId ? `Made a kit: ${res.placed.length} pads` : 'No pad got a sound: select one-shots that have been analyzed.', res.channelId ? 'info' : 'error');
    },
  });
  addMenuItems('file', [cmd('samples.addFolder', 73)]);
  addActionProvider('samples', (s) => [
    {
      key: 'samples.browse',
      label: 'Browse my samples',
      path: ['View', 'Sample browser'],
      hint: 'Your sample folders, sorted: kicks, snares, hats, loops with their tempo and key',
      keywords: ['sample', 'samples', 'browser', 'kick', 'snare', 'hat', 'loop', 'drum', 'sound', 'library', 'folder', 'find', 'search', 'tempo', 'key'],
      run: () => void s.commands.run('samples.open'),
    },
    {
      key: 'samples.kit',
      label: 'Make a drum kit from my samples',
      path: ['Samples', 'Make a drum kit'],
      hint: 'Select one-shots in the sample browser, then make a Drum Pads kit with kick, snare and hats on the right pads',
      keywords: ['kit', 'drum', 'pads', 'samples', 'kick', 'snare', 'hat', 'make'],
      run: () => void s.commands.run('samples.open'),
    },
  ]);
  setWindowHelp('samples', {
    intro: 'Your sample folders, sorted out. Click a sound to hear it, filter by type, tempo or key, and drag what you like into the project.',
    moves: [
      ['Add folder', 'Pick a folder of your sounds once; the browser reads it, works out what each sound is and keeps the results for next time'],
      ['Click a row', 'Hear the sound. Loops play at your project tempo from the next beat while the song plays; click again to stop'],
      ['↑ ↓', 'Step through the list, playing each sound (Shift extends the selection); Enter plays or stops; A adds the sound to the project; F stars it; Esc stops'],
      ['Chips and boxes', 'Type of sound, loops, favorites, recently used, a tempo range and the note or key narrow the list; the search box also finds your tags'],
      ['Drag a row', 'Onto the channel rack (a new sampler channel, or the sample of the channel you drop on), the playlist (an audio clip) or a Drum Pads pad'],
      ['Double-click', 'Add a one-shot as a sampler channel, or a loop as an audio clip on the playlist that follows the song tempo'],
      ['Right-click', 'Find similar sounds, add to the project, star, tag, or make a drum kit from the selected one-shots'],
      ['Footer', 'Preview volume, loops to song tempo (stretch keeps the pitch, resample is like a record), notes moved to the song key, play on arrow keys'],
    ],
  });
  services.sampleBrowser.start();
  // The audition level follows the window's volume (and the saved one when the app opens).
  const syncVolume = () => services.engine.setPreviewVolume(services.sampleBrowser.store.getState().volume);
  let lastVolume = -1;
  services.sampleBrowser.store.subscribe((st) => {
    if (st.volume === lastVolume) return;
    lastVolume = st.volume;
    syncVolume();
  });
  void loadSampleFolders().catch((e: unknown) => {
    console.warn('Sample folders unavailable:', e);
    services.session.getState().toast("Couldn't load your sample folders.", 'error');
  });
}
