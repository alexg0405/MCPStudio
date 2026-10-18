import type { Services } from '@app/services';
import { applyProgressionByName, clearChordTrack, typeChords, type ActionResult } from '@app/harmony/chord-track';
import { detectChords, type DetectWhere } from '@app/harmony/detect';
import { fitMelodyToChords, makeBassline, makeChordPart } from '@app/harmony/parts';
import { BASS_STYLES, type BassStyle } from '@core/harmony/bassline';
import type { Register } from '@core/harmony/plan';
import { COMP_RHYTHMS, type CompRhythm, type Spread } from '@core/harmony/voicing';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addContextMenuItems } from '../../context-menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow } from '../../workspace/registry';

/** Shows what an action did as a toast. */
function report(services: Services, result: ActionResult): void {
  services.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

const hasChords = (s: Services) => !!s.doc.getState().project.chords;
const DETECT_PLACES: readonly DetectWhere[] = ['song', 'selection', 'loop', 'pattern'];

/** Whether the lane is on screen right now (the musician's choice, else whether there are chords). */
function laneShown(s: Services): boolean {
  return s.editor.getState().chordLane ?? hasChords(s);
}

/**
 * Harmony: the chord track (a lane above the playlist, shown behind the piano roll), detecting chords, a palette of
 * progressions, and writing chords, a bassline and a melody that fit it. Studio has the same through the `chords`,
 * `voice_chords`, `bassline` and `fit_melody` actions and the `get_chords` read.
 */
export function register(services: Services): void {
  registerWindowType({
    type: 'chords',
    title: () => 'Chords',
    component: lazyWindow(() => import('./ChordsWindow'), (m) => m.ChordsWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 340)), y: 48, w: Math.min(680, ws.w), h: Math.min(700, ws.h - 70) }),
    minSize: { w: 460, h: 320 },
  });
  registerWindowToggle(services, {
    command: 'view.chords',
    type: 'chords',
    title: 'Chords',
    hint: 'The chord track: type chords, pick a progression, detect the chords you have, and write chords, a bassline and a melody that fit',
    chords: ['Alt+Shift+H'],
    menuOrder: 60,
  });

  const { commands } = services;
  commands.register({
    id: 'chords.showLane',
    title: 'Show the chord lane',
    category: 'Chords',
    hint: 'The chord lane above the playlist: chords over time, typed or dragged, lined up with the bars',
    checked: laneShown,
    run: (s) => s.editor.getState().setChordLane(!laneShown(s)),
  });
  commands.register<string | { text?: string; bar?: number; barsPerChord?: number }>({
    id: 'chords.type',
    title: 'Type chords…',
    category: 'Chords',
    hint: 'Put chords on the chord track from text: Am7 | F | C | G (one a bar; a dot holds the chord before)',
    argsHint: '"Am7 | F | C | G" or { text, bar (1-based first bar), barsPerChord }',
    run: (s, args) => {
      const options = typeof args === 'string' ? { text: args } : (args ?? {});
      if (!options.text) {
        openWindow(s, 'chords');
        return;
      }
      report(s, typeChords(s, options.text, { ...(options.bar ? { startBar: options.bar } : {}), ...(options.barsPerChord ? { barsPerChord: options.barsPerChord } : {}) }));
    },
  });
  commands.register<{ where?: DetectWhere; resolution?: 'bar' | 'half' }>({
    id: 'chords.detect',
    title: 'Detect chords',
    category: 'Chords',
    hint: 'Read the chords your song already plays (chord, pad, keys and bass parts, and audio clips) and fill the chord track',
    argsHint: `optional { where: ${DETECT_PLACES.join(' | ')}, resolution: bar | half } (default the whole song, a bar at a time)`,
    run: async (s, args) => {
      const where = args?.where && DETECT_PLACES.includes(args.where) ? args.where : 'song';
      report(s, await detectChords(s, { where, ...(args?.resolution ? { resolution: args.resolution } : {}) }));
    },
  });
  commands.register<string | { progression: string; bar?: number; bars?: number; sevenths?: boolean }>({
    id: 'chords.progression',
    title: 'Put a progression on the chord track…',
    category: 'Chords',
    hint: 'A common progression (I–V–vi–IV, i–VI–III–VII, ii–V–I, 12-bar blues, trap loops…) in the song key',
    argsHint: 'a progression id or name, e.g. "pop-axis", or { progression, bar, bars, sevenths }; the Chords window lists them by mood and genre',
    run: (s, args) => {
      if (!args) {
        openWindow(s, 'chords');
        return;
      }
      const options = typeof args === 'string' ? { progression: args } : args;
      report(
        s,
        applyProgressionByName(s, options.progression, {
          ...(options.bar ? { startBar: options.bar } : {}),
          ...(options.bars ? { bars: options.bars } : {}),
          ...(options.sevenths ? { sevenths: true } : {}),
        }),
      );
    },
  });
  commands.register<{ fromBar?: number; toBar?: number }>({
    id: 'chords.clear',
    title: 'Clear the chord track',
    category: 'Chords',
    hint: 'Remove every chord from the chord track (one undo step)',
    argsHint: 'optional { fromBar, toBar } (1-based, inclusive) to clear only those bars',
    enabled: hasChords,
    run: (s, args) => report(s, clearChordTrack(s, args?.fromBar, args?.toBar)),
  });
  commands.register<{ register?: Register; spread?: Spread; rhythm?: CompRhythm; bass?: boolean }>({
    id: 'chords.makeChords',
    title: 'Make chords from the chord track',
    category: 'Chords',
    hint: 'Write voiced chords for the chord track into the selected channel’s pattern, each moving as little as possible from the last (voice leading)',
    argsHint: `optional { register: low | mid | high, spread: close | open | drop2, rhythm: ${COMP_RHYTHMS.join(' | ')}, bass: true }; the selected channel and current pattern`,
    enabled: hasChords,
    run: (s, args) => report(s, makeChordPart(s, args ?? {})),
  });
  commands.register<BassStyle>({
    id: 'chords.makeBassline',
    title: 'Make a bassline from the chord track',
    category: 'Chords',
    hint: 'Write a bassline that follows the chord track into the selected channel’s pattern (an 808 hits where the beat’s kick hits)',
    argsHint: `${BASS_STYLES.join(' | ')} (default roots); the selected channel and current pattern`,
    enabled: hasChords,
    run: (s, style) => report(s, makeBassline(s, { style: style && BASS_STYLES.includes(style) ? style : 'roots' })),
  });
  commands.register<number>({
    id: 'chords.fitMelody',
    title: 'Fit the melody to the chords',
    category: 'Chords',
    hint: 'Move the selected notes (or the channel’s notes) onto chord tones on strong beats and scale tones elsewhere; timing is unchanged',
    argsHint: 'strength 0–100 % (default 100): how many of the notes that are off get moved, smallest moves first',
    enabled: hasChords,
    run: (s, strength) => report(s, fitMelodyToChords(s, Math.max(0, Math.min(100, strength ?? 100)) / 100)),
  });

  addMenuItems('playlist', [
    sep(39),
    cmd('chords.showLane', 40),
    cmd('chords.detect', 41),
    cmd('chords.clear', 42),
    sep(43),
  ]);
  addMenuItems('edit', [sep(177), cmd('chords.makeChords', 178), cmd('chords.makeBassline', 179), cmd('chords.fitMelody', 180)]);
  addContextMenuItems('pianoRoll.empty', (_ctx, s) => [
    { kind: 'label', label: 'Chord track' },
    { label: 'Make chords from the chord track', disabled: !hasChords(s), hint: 'Voiced chords for the chord track, with voice leading', onSelect: () => void s.commands.run('chords.makeChords') },
    { label: 'Make a bassline from the chord track', disabled: !hasChords(s), hint: 'Roots, root and fifth, walking or an 808 that follows the kick (choose in the Chords window)', onSelect: () => void s.commands.run('chords.makeBassline') },
    { label: 'Open the Chords window', onSelect: () => void openWindow(s, 'chords') },
  ]);
  addContextMenuItems('pianoRoll.note', (_ctx, s) => [
    { label: 'Fit notes to the chords', disabled: !hasChords(s), hint: 'Move these notes onto chord tones on strong beats and scale tones elsewhere', onSelect: () => void s.commands.run('chords.fitMelody') },
  ]);
  addActionProvider('chords', (s) => [
    {
      key: 'chords.open',
      label: 'Chords, progressions and harmony',
      path: ['View', 'Chords'],
      hint: 'Type chords, pick a progression by mood or genre, detect chords, and write chords, a bassline and a melody that fit',
      keywords: ['chord', 'chords', 'progression', 'harmony', 'key', 'bassline', 'bass', 'melody', 'voice leading', 'detect', 'theory'],
      run: () => openWindow(s, 'chords'),
    },
  ]);
  setWindowHelp('chords', {
    intro: 'The song’s harmony. Put chords on the chord track, then write chords, a bassline and a melody that all fit it.',
    moves: [
      ['Type chords', 'Am7 | F | C | G puts one chord a bar on the chord track (a dot holds the chord before)'],
      ['The chord lane', 'Above the playlist: click to type a chord, drag across to draw, drag a chord to move it, drag its edges to resize, right-click for more'],
      ['Detect chords', 'Reads the chords your chord, pad, keys and bass parts (and audio clips) already play; faded chords are guesses'],
      ['Progressions', 'Common progressions by mood and genre, in the song key; “Use” puts one on the chord track'],
      ['Next chord ideas', 'Chords that fit after the last one, ranked by whether they lead home, away or to tension'],
      ['Make chords', 'Voiced chords with voice leading for the selected channel’s pattern'],
      ['Make a bassline', 'Roots, root and fifth, walking, or an 808 that hits where the kick hits'],
      ['Fit melody', 'Moves notes onto chord tones on strong beats and scale tones elsewhere; strength sets how many'],
      ['Studio', 'Ask “put a sad lo-fi progression in A minor and write a bassline for it” and Studio does it in one undo step'],
    ],
  });
}
