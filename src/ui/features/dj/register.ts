import type { Services } from '@app/services';
import { analyzeLibrary, library, loadLibrary, makeLibraryMix, pickSongFiles, pickSongFolder } from '@app/dj/library';
import type { DjMixOptions } from '@core/model/types';
import { addActionProvider } from '../../shell/actions';
import { addBrowserSection } from '../../shell/Browser';
import { addMenuItems, cmd } from '../../shell/menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';
import { MusicSection } from './MusicSection';
import { MAX_LENGTH_TARGET_MIN, MAX_MIX_BPM, MIN_MIX_BPM } from './dj-view';
import { makeMixFromUi } from './run';

/** The DJ window opens this big (px) when the workspace has room, with this gap above it. */
const WINDOW_WIDTH_PX = 940;
const WINDOW_HEIGHT_PX = 600;
const WINDOW_TOP_PX = 40;

/** `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** The mix tempo in the args: a BPM (held in range), 'follow', or what the current options say. */
function mixTempoFrom(wanted: unknown, fallback: DjMixOptions['mixTempo']): DjMixOptions['mixTempo'] {
  if (typeof wanted === 'number' && Number.isFinite(wanted)) return Math.min(MAX_MIX_BPM, Math.max(MIN_MIX_BPM, wanted));
  return wanted === 'follow' ? 'follow' : fallback;
}

/** Options for `dj.makeMix` from args (the rest from the current mix, else the defaults). */
export function mixOptionsFrom(raw: unknown, base: DjMixOptions): DjMixOptions {
  const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lengthMin = typeof args.lengthMin === 'number' && args.lengthMin > 0 ? Math.min(MAX_LENGTH_TARGET_MIN, args.lengthMin) : base.lengthTargetMin;
  const keyLock = typeof args.keyLock === 'boolean' ? args.keyLock : base.keyLock;
  return {
    order: oneOf(args.order, ['auto', 'keep'], base.order),
    energy: oneOf(args.energy, ['build', 'party', 'chill', 'peak-time'], base.energy),
    transition: oneOf(args.transition, ['auto', 'smooth', 'quick', 'cut'], base.transition),
    mixTempo: mixTempoFrom(args.mixTempo, base.mixTempo),
    ...(lengthMin ? { lengthTargetMin: lengthMin } : {}),
    ...(keyLock ? { keyLock: true } : {}),
  };
}

/** DJ mode: the music library, the auto-mix and its transitions. */
export function register(services: Services): void {
  registerWindowType({
    type: 'dj',
    title: () => 'DJ mix',
    component: lazyWindow(() => import('./DjWindow'), (m) => m.DjWindow),
    defaultRect: (ws) => ({
      x: Math.max(0, Math.round(ws.w / 2 - WINDOW_WIDTH_PX / 2)),
      y: WINDOW_TOP_PX,
      w: Math.min(WINDOW_WIDTH_PX, ws.w),
      h: Math.min(WINDOW_HEIGHT_PX, ws.h - WINDOW_TOP_PX - 20),
    }),
    minSize: { w: 520, h: 300 },
  });
  registerWindowToggle(services, {
    command: 'dj.open',
    type: 'dj',
    title: 'DJ mix',
    hint: 'Your music library and the auto-mix: songs in, Studio orders and beat-matches them and builds every transition',
    chords: ['Alt+J'],
    menuOrder: 57,
  });
  const { commands } = services;
  commands.register({
    id: 'dj.addFiles',
    title: 'Add music files…',
    category: 'DJ',
    hint: 'Add your own song files (MP3, AAC/M4A, WAV, FLAC, OGG) to the music library',
    gesture: true,
    run: async (s) => void (await pickSongFiles(s)),
  });
  commands.register({
    id: 'dj.addFolder',
    title: 'Add a music folder…',
    category: 'DJ',
    hint: 'Add every song in a folder (and its subfolders) to the music library',
    gesture: true,
    run: async (s) => void (await pickSongFolder(s)),
  });
  commands.register<unknown>({
    id: 'dj.makeMix',
    title: 'Make the DJ mix',
    category: 'DJ',
    hint: 'Mix the selected library songs (or all of them) on the playlist: ordered, beat-matched, with transitions',
    argsHint: "optional { order: 'auto' | 'keep', energy: 'build' | 'party' | 'chill' | 'peak-time', transition: 'auto' | 'smooth' | 'quick' | 'cut', mixTempo: 'follow' | BPM, lengthMin: minutes, keyLock: boolean }",
    enabled: () => library.getState().songs.length > 0 && library.getState().making === null,
    run: async (s, args) => {
      const { DEFAULT_DJ_OPTIONS } = await import('@app/dj/mix');
      const options = mixOptionsFrom(args, s.doc.getState().project.dj?.options ?? DEFAULT_DJ_OPTIONS);
      if (args === undefined) return makeMixFromUi(s, options);
      try {
        await makeLibraryMix(s, options);
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  commands.register({
    id: 'dj.exportMix',
    title: 'Export the DJ mix…',
    category: 'DJ',
    hint: 'Render the whole mix (song mode, from bar 1 to its end) to a WAV, FLAC or MP3 file',
    enabled: (s) => !!s.doc.getState().project.dj,
    run: (s) => {
      s.view.getState().setMode('song');
      s.view.getState().setLoop(null);
      s.commands.run('file.exportWav');
    },
  });
  addMenuItems('file', [cmd('dj.exportMix', 72)]);
  addBrowserSection({ id: 'music', title: 'Music', icon: 'note', order: 24, component: MusicSection });
  addActionProvider('dj', (s) => [
    {
      key: 'dj.party-mix',
      label: 'Make a DJ mix from my songs',
      path: ['View', 'DJ mix'],
      hint: 'A party mix from your own music files: ordered, beat-matched, with transitions',
      keywords: ['dj', 'party', 'mix', 'playlist', 'songs', 'music', 'spotify', 'crossfade', 'beatmatch'],
      run: () => void s.commands.run('dj.open'),
    },
  ]);
  setWindowHelp('dj', {
    intro: 'Make a party mix from your own songs: add them, press Make the mix, then tweak.',
    moves: [
      ['Add files / Add folder', 'Your own MP3, AAC, WAV or FLAC files (streaming services like Spotify can’t be mixed: their audio is locked)'],
      ['Rows', 'Click to select (only selected songs are mixed), drag to reorder, Pin keeps a song’s place in auto order'],
      ['Key badge', 'Camelot wheel: neighbours (8A next to 7A, 9A, 8B) mix smoothly'],
      ['Order / Energy', 'Auto orders by key, tempo and the energy shape; Keep plays the list as it is'],
      ['Make the mix', 'Writes the mix on the playlist as one undo step; making it again replaces it'],
      ['Transitions', 'Change one transition’s length or style, add a riser, or play from just before it'],
    ],
  });
  void loadLibrary().then(() => {
    if (library.getState().songs.length) void analyzeLibrary(services);
  });
}
