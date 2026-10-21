import { createElement } from 'react';
import type { Services } from '@app/services';
import { barsToRange, findPattern, isPatternPlaying, playFrom, playPattern, playRange } from '@app/actions/transport';
import { ticksPerBar } from '@core/time/ppq';
import { setBpm, setSwing } from '@core/ops/notes';
import { showFormDialog } from '../../controls/FormDialog';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { TransportBar } from './TransportBar';
import { AudioStatus } from './AudioStatus';

export const order = 10;

const BEAT_UNITS = [
  { value: '2', label: 'Half notes (2)' },
  { value: '4', label: 'Quarter notes (4)' },
  { value: '8', label: 'Eighth notes (8)' },
  { value: '16', label: 'Sixteenth notes (16)' },
] as const;

/** Tempo, time signature and swing in one plain dialog (one undo step). */
async function songSettings(s: Services): Promise<void> {
  const t = s.doc.getState().project.transport;
  const values = await showFormDialog({
    title: 'Song settings',
    message: 'These apply to the whole song. Swing delays every other 1/16 step for a groovier feel.',
    fields: [
      { kind: 'number', key: 'bpm', label: 'Tempo', min: 10, max: 522, step: 'any', unit: 'BPM' },
      { kind: 'number', key: 'beats', label: 'Beats per bar', min: 1, max: 32 },
      { kind: 'choice', key: 'unit', label: 'Beat length', options: BEAT_UNITS },
      { kind: 'number', key: 'swing', label: 'Swing', min: 0, max: 100, unit: '%' },
    ],
    values: { bpm: t.bpm, beats: t.timeSig.num, unit: String(t.timeSig.den), swing: Math.round(t.swing * 100) },
    okLabel: 'Apply',
  });
  if (!values) return;
  const den = Number(values.unit);
  s.history.transact('Song settings', (d) => {
    setBpm(d, Number(values.bpm));
    // A fractional swing (33.3%) is kept unless its field was changed.
    if (Number(values.swing) !== Math.round(t.swing * 100)) setSwing(d, Number(values.swing) / 100);
    const num = Math.round(Number(values.beats));
    if (num >= 1 && num <= 32 && [2, 4, 8, 16].includes(den)) d.transport.timeSig = { num, den };
  });
}

/** The tick `transport.playFrom` was asked for: a plain tick number, `{ tick }`, or `{ bar }` (bar 1 = the start); NaN when unreadable. */
function tickToPlayFrom(args: number | { tick?: number; bar?: number } | undefined, ticksInBar: number): number {
  if (typeof args === 'number') return args;
  if (args && typeof args.tick === 'number') return args.tick;
  if (args && typeof args.bar === 'number') return (Math.max(1, args.bar) - 1) * ticksInBar;
  return NaN;
}

/** The span `transport.playRange` was asked for: `{ fromBar, toBar }` or `{ from, to }` in ticks; null when unreadable. */
function spanToLoop(s: Services, args: { from?: number; to?: number; fromBar?: number; toBar?: number } | undefined): { from: number; to: number } | null {
  if (args && typeof args.fromBar === 'number' && typeof args.toBar === 'number') return barsToRange(s, args.fromBar, args.toBar);
  if (args && typeof args.from === 'number' && typeof args.to === 'number') return { from: args.from, to: args.to };
  return null;
}

/** The transport: play, stop, record settings, the song settings dialog, their keys, menu entries and the toolbar slots. */
export function register(services: Services): void {
  registerPlaybackCommands(services);
  registerRecordCommands(services);
  registerSongCommands(services);
  registerKeys(services);
  registerOptionsMenu(services);
  registerToolbarSlots();
}

/** Play, stop, and the commands that start playback from a pattern, a position or a span. */
function registerPlaybackCommands({ commands }: Services): void {
  commands.register({
    id: 'transport.playPause',
    title: 'Play / stop',
    category: 'Transport',
    hint: 'Start or stop playback',
    run: (s) => {
      if (s.engine.playing) s.engine.stop();
      else {
        const v = s.view.getState();
        s.engine.play(v.mode === 'song' ? v.songStart : 0);
      }
    },
    checked: (s) => s.engine.playing,
  });
  commands.register({
    id: 'transport.stop',
    title: 'Stop',
    category: 'Transport',
    hint: 'Stop playback and return to the start',
    run: (s) => s.engine.stop(),
  });
  commands.register<string | number | { patternId?: string; pattern?: string | number } | undefined>({
    id: 'transport.playPattern',
    title: 'Play this pattern',
    category: 'Transport',
    hint: 'Loop a pattern from its start (pattern mode); it becomes the current pattern. Without a pattern: the one you are editing',
    argsHint: 'optional: { patternId } or the pattern’s name or number (without: the current pattern)',
    checked: (s) => isPatternPlaying(s),
    run: (s, args) => {
      const ref = typeof args === 'object' && args ? (args.patternId ?? args.pattern) : args;
      const id = ref === undefined ? s.view.getState().currentPatternId : findPattern(s, ref);
      if (!id || !playPattern(s, id)) s.session.getState().toast('There is no pattern to play.', 'error');
    },
  });
  commands.register<number | { tick?: number; bar?: number }>({
    id: 'transport.playFrom',
    title: 'Play the song from here',
    category: 'Transport',
    hint: 'Play the playlist (song mode) from a position; a loop region that does not include it is cleared',
    argsHint: '{ tick } or { bar } (bar 1 = the start), or a tick number',
    palette: false,
    run: (s, args) => {
      const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
      const tick = tickToPlayFrom(args, bar);
      if (Number.isFinite(tick)) playFrom(s, tick);
      else s.session.getState().toast('Say where to play from: a bar or a tick.', 'error');
    },
  });
  commands.register<{ from?: number; to?: number; fromBar?: number; toBar?: number }>({
    id: 'transport.playRange',
    title: 'Loop and play a span',
    category: 'Transport',
    hint: 'Loop a span of the song and play it from its start (song mode); the span becomes the loop region',
    argsHint: '{ from, to } in ticks, or { fromBar, toBar } (bar 1 = the start, both bars included)',
    palette: false,
    run: (s, args) => {
      const r = spanToLoop(s, args);
      if (!r || !playRange(s, r.from, r.to)) s.session.getState().toast('Say which span to loop: from and to.', 'error');
    },
  });
}

/** Recording: arm, metronome, count-in, record quantize and record mode. */
function registerRecordCommands({ commands }: Services): void {
  commands.register({
    id: 'transport.record',
    title: 'Record',
    category: 'Transport',
    hint: 'Arm recording: press Play to record what the chip next to it says (notes and knob moves, audio, or both)',
    run: (s) => s.recording.toggle(),
    checked: (s) => s.recording.armed,
  });
  commands.register({
    id: 'transport.metronome',
    title: 'Metronome',
    category: 'Transport',
    hint: 'Click on every beat while playing',
    run: (s) => s.prefs.getState().set({ metronome: !s.prefs.getState().metronome }),
    checked: (s) => s.prefs.getState().metronome,
  });
  commands.register<number>({
    id: 'transport.countIn',
    argsHint: 'bars of count-in: 0 (off), 1, 2 or 4',
    title: 'Count-in',
    category: 'Transport',
    hint: 'Bars of clicks before recording starts',
    run: (s, bars) => s.prefs.getState().set({ countInBars: Math.max(0, Math.min(4, Number(bars) || 0)) }),
  });
  commands.register<number>({
    id: 'transport.recordQuantize',
    argsHint: 'grid in ticks: 0 (off), 960 (1/4), 480 (1/8), 240 (1/16), 120 (1/32), 320 (1/8 triplet), 160 (1/16 triplet)',
    title: 'Record quantize',
    category: 'Transport',
    hint: 'Snap recorded notes to a grid as you play',
    run: (s, ticks) => s.prefs.getState().set({ recordQuantize: Math.max(0, Number(ticks) || 0) }),
  });
  commands.register<string>({
    id: 'transport.recordMode',
    argsHint: "'overdub' (add notes) or 'replace'",
    title: 'Record mode',
    category: 'Transport',
    hint: 'Overdub adds to existing notes; replace clears what the recording passes over',
    run: (s, mode) => s.prefs.getState().set({ recordMode: mode === 'replace' ? 'replace' : 'overdub' }),
  });
  commands.register<string>({
    id: 'transport.recordMidiFx',
    argsHint: "'played' (the keys you play) or 'generated' (the notes a channel's MIDI effects make of them)",
    title: 'Record what MIDI effects make',
    category: 'Transport',
    hint: 'On a channel with MIDI effects, record the keys you play, or the notes the effects make of them (an arpeggio, a chord)',
    run: (s, what) => s.prefs.getState().set({ recordMidiFx: what === 'generated' ? 'generated' : 'played' }),
  });
}

/** Panic, the song settings dialog and the pattern or song mode switch. */
function registerSongCommands({ commands }: Services): void {
  commands.register({
    id: 'transport.panic',
    title: 'Stop all sound',
    category: 'Transport',
    hint: 'Stops playback and silences every note and echo right away (when something keeps sounding)',
    run: (s) => s.engine.panic(),
  });
  commands.register({
    id: 'song.settings',
    title: 'Song settings…',
    category: 'Song',
    hint: 'Tempo (BPM), time signature (beats per bar) and swing for the whole song',
    // A dialog; the song action sets all of it.
    ai: false,
    run: (s) => songSettings(s),
  });
  commands.register({
    id: 'transport.toggleMode',
    title: 'Pattern / song mode',
    category: 'Transport',
    hint: 'Switch between looping the current pattern (PAT) and playing the playlist (SONG)',
    run: (s) => s.view.getState().setMode(s.view.getState().mode === 'pattern' ? 'song' : 'pattern'),
    checked: (s) => s.view.getState().mode === 'song',
  });

}

/** The transport keys. */
function registerKeys({ keymap }: Services): void {
  keymap.add([
    { chord: 'Space', command: 'transport.playPause' },
    { chord: 'L', command: 'transport.toggleMode' },
    { chord: 'R', command: 'transport.record' },
    { chord: 'Alt+M', command: 'transport.metronome' },
  ]);

}

/** The options of one record setting as menu entries; the chosen one is checked. */
function choiceEntries<T>(choices: readonly (readonly [string, T])[], current: T, pick: (value: T) => void) {
  return choices.map(([label, value]) => ({ label, checked: current === value, run: () => pick(value) }));
}

/** Record quantize grids, in ticks (960 per quarter note). */
const RECORD_QUANTIZE_CHOICES = [
  ['Off', 0],
  ['1/4', 960],
  ['1/8', 480],
  ['1/16', 240],
  ['1/32', 120],
  ['1/8 triplet', 320],
  ['1/16 triplet', 160],
] as const;

/** The count-in lengths offered, in bars. */
const COUNT_IN_BARS = [0, 1, 2, 4] as const;

/** The Options menu's record settings, read fresh each time the menu opens so the checks are current. */
function recordSettingEntries(services: Services) {
  const prefs = services.prefs.getState();
  const run = (id: string, arg: unknown) => services.commands.run(id, arg);
  const countInChoices = COUNT_IN_BARS.map((bars) => [bars ? `${bars} bar${bars > 1 ? 's' : ''}` : 'Off', bars] as const);
  return [
    {
      label: 'Count-in',
      run: () => {},
      children: choiceEntries(countInChoices, prefs.countInBars, (bars) => run('transport.countIn', bars)),
    },
    {
      label: 'Record quantize',
      run: () => {},
      children: choiceEntries(RECORD_QUANTIZE_CHOICES, prefs.recordQuantize, (ticks) => run('transport.recordQuantize', ticks)),
    },
    {
      label: 'Record mode',
      run: () => {},
      children: choiceEntries(
        [
          ['Overdub (add notes)', 'overdub'],
          ['Replace (clear as it records)', 'replace'],
        ] as const,
        prefs.recordMode,
        (mode) => run('transport.recordMode', mode),
      ),
    },
    {
      label: 'Record MIDI effects',
      run: () => {},
      children: choiceEntries(
        [
          ['The keys I play', 'played'],
          ['The notes the effects make', 'generated'],
        ] as const,
        prefs.recordMidiFx,
        (what) => run('transport.recordMidiFx', what),
      ),
    },
  ];
}

/** Transport lives on the toolbar; the Options menu keeps the mode switch, panic, metronome and record settings reachable from menus. */
function registerOptionsMenu(services: Services): void {
  addMenuItems('options', [
    sep(1),
    cmd('transport.toggleMode', 2),
    cmd('song.settings', 3),
    sep(70),
    cmd('transport.panic', 69),
    cmd('transport.metronome', 71),
    cmd('transport.record', 72, 'Record (arm)'),
    { kind: 'dynamic', id: 'record-settings', order: 73, entries: () => recordSettingEntries(services) },
  ]);
}

/** The transport and audio status on the toolbar. */
function registerToolbarSlots(): void {
  addToolbarSlot({ id: 'transport', area: 'transport', order: 0, component: () => createElement(TransportBar) });
  addToolbarSlot({
    id: 'audio-enable',
    area: 'right',
    order: 0,
    component: () => createElement(AudioStatus, { show: 'enable' }),
  });
  addToolbarSlot({
    id: 'audio-status',
    area: 'center',
    order: 100,
    component: () => createElement(AudioStatus, { show: 'stats' }),
  });
}
