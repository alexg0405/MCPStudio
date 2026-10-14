import type { Services } from '@app/services';
import { MASTER, type ChannelId, type Project } from '@core/model/types';
import { openWindow } from '../../workspace/registry';

/**
 * Lessons: learn by doing. Each step says what to do in plain words, points at where to do it, and
 * moves on by itself once the project shows it was done (no "Next" needed). The steps build on each
 * other: a beat, then a melody, a song and a mix.
 */
export interface LessonStep {
  text: string;
  /** Where to look (a CSS selector), if anywhere. */
  anchor?(s: Services): string | null;
  /** Runs when the step starts (open a window, remember a value to compare with). */
  prepare?(s: Services): void;
  done(s: Services): boolean;
}

export interface Lesson {
  id: string;
  title: string;
  summary: string;
  minutes: number;
  /** Before the first step; false cancels the lesson (e.g. the musician kept their project). */
  start?(s: Services): Promise<boolean>;
  steps: LessonStep[];
  /** What to try next, shown at the end. */
  next: string;
}

const project = (s: Services): Project => s.doc.getState().project;
const pattern = (s: Services) => {
  const id = s.view.getState().currentPatternId;
  return id ? project(s).patterns[id] : undefined;
};
const channelNamed = (s: Services, name: string): ChannelId | null =>
  project(s).channelOrder.find((id) => project(s).channels[id]?.name.toLowerCase() === name.toLowerCase()) ?? null;
/** The 1/16 steps (0-based) a channel has notes on in the current pattern. */
const steps = (s: Services, id: ChannelId | null): Set<number> => {
  const notes = id ? pattern(s)?.notes[id] : undefined;
  return new Set(Object.values(notes ?? {}).map((n) => Math.round(n.tick / 240)));
};
const has = (set: Set<number>, ...want: number[]) => want.every((x) => set.has(x));
const row = (s: Services, name: string) => {
  const id = channelNamed(s, name);
  return id ? `[data-channel-id="${id}"]` : '[data-window-type="channel-rack"]';
};
const visible = (s: Services, type: string) =>
  Object.values(s.view.getState().windows).some((w) => w.type === type && w.visible);
const synthId = (s: Services): ChannelId | null =>
  project(s).channelOrder.find((id) => {
    const c = project(s).channels[id];
    return c?.kind === 'instrument' && c.plugin.pluginId === 'agstudio.3xosc';
  }) ?? null;

/** Values a step compares against (set by its prepare). */
const memo: { bpm: number; notes: string; volume: number } = { bpm: 0, notes: '', volume: 0 };
const notesKey = (s: Services, id: ChannelId | null) =>
  JSON.stringify(Object.values((id ? pattern(s)?.notes[id] : undefined) ?? {}).map((n) => [n.tick, n.key, n.length, n.velocity]));

export const LESSONS: readonly Lesson[] = [
  {
    id: 'first-beat',
    title: 'Your first beat',
    summary: 'Kick, clap and hi-hats in the channel rack, then play it.',
    minutes: 2,
    start: async (s) => {
      const ok = await s.files.newProject();
      if (ok) openWindow(s, 'channel-rack');
      return ok;
    },
    steps: [
      {
        text: 'Click steps 1, 5, 9 and 13 in the Kick row: a kick on every beat.',
        anchor: (s) => row(s, 'Kick'),
        done: (s) => has(steps(s, channelNamed(s, 'Kick')), 0, 4, 8, 12),
      },
      {
        text: 'Now a clap on beats 2 and 4: steps 5 and 13 in the Clap row.',
        anchor: (s) => row(s, 'Clap'),
        done: (s) => has(steps(s, channelNamed(s, 'Clap')), 4, 12),
      },
      {
        text: 'Hi-hats keep time: click every other step in the Hat row (1, 3, 5 … 15). Tip: drag across to paint.',
        anchor: (s) => row(s, 'Hat'),
        done: (s) => [0, 2, 4, 6, 8, 10, 12, 14].filter((x) => steps(s, channelNamed(s, 'Hat')).has(x)).length >= 7,
      },
      {
        text: 'Press Space (or ▶ in the toolbar) to hear your beat.',
        anchor: () => '[data-tour="transport"]',
        done: (s) => s.engine.playing,
      },
      {
        text: 'Make it faster or slower: drag the BPM number up or down (or scroll over it).',
        anchor: () => '[data-tour="tempo"]',
        prepare: (s) => void (memo.bpm = project(s).transport.bpm),
        done: (s) => Math.abs(project(s).transport.bpm - memo.bpm) >= 1,
      },
    ],
    next: 'Next: “Write a melody”, in Help → Lessons.',
  },
  {
    id: 'melody',
    title: 'Write a melody',
    summary: 'Add a synth and draw notes in the piano roll.',
    minutes: 3,
    steps: [
      {
        text: 'Add a synth: click 3xOsc under Plugins in the browser on the left.',
        anchor: () => '[data-tour="browser"]',
        done: (s) => synthId(s) !== null,
      },
      {
        text: 'Open its piano roll: right-click the 3xOsc name in the channel rack and choose Piano roll.',
        anchor: (s) => {
          const id = synthId(s);
          return id ? `[data-channel-id="${id}"]` : '[data-window-type="channel-rack"]';
        },
        done: (s) => visible(s, 'piano-roll') && s.session.getState().selectedChannelId === synthId(s),
      },
      {
        text: 'Click in the grid to draw at least four notes. Higher rows are higher notes; drag a note’s end to make it longer.',
        anchor: () => '[data-window-type="piano-roll"]',
        done: (s) => {
          const id = synthId(s);
          return Object.keys((id ? pattern(s)?.notes[id] : undefined) ?? {}).length >= 4;
        },
      },
      {
        text: 'Press Space to hear the melody with your beat.',
        anchor: () => '[data-tour="transport"]',
        done: (s) => s.engine.playing,
      },
      {
        text: 'Try a tool: Tools ▾ → Humanize… (or any other) in the piano roll, then Apply.',
        anchor: () => '[data-window-type="piano-roll"]',
        prepare: (s) => void (memo.notes = notesKey(s, synthId(s))),
        done: (s) => notesKey(s, synthId(s)) !== memo.notes,
      },
    ],
    next: 'Next: “Make it a song”, in Help → Lessons.',
  },
  {
    id: 'song',
    title: 'Make it a song',
    summary: 'Lay your pattern out on the playlist and play the song.',
    minutes: 2,
    steps: [
      {
        text: 'Switch the transport to SONG: click SONG next to the play button (or press L).',
        anchor: () => '[data-tour="transport"]',
        done: (s) => s.view.getState().mode === 'song',
      },
      {
        text: 'Open the Playlist: press F5, or its button on the right of the toolbar.',
        anchor: () => '[data-tour="windows"]',
        done: (s) => visible(s, 'playlist'),
      },
      {
        text: 'Click in Track 1 four times, one after another, to place your pattern four times.',
        anchor: () => '[data-window-type="playlist"]',
        done: (s) => Object.values(project(s).playlist.clips).filter((c) => c.kind === 'pattern').length >= 4,
      },
      {
        text: 'Play the song: press Space.',
        anchor: () => '[data-tour="transport"]',
        done: (s) => s.engine.playing && s.view.getState().mode === 'song',
      },
    ],
    next: 'Next: “Mix it”, in Help → Lessons.',
  },
  {
    id: 'mix',
    title: 'Mix it',
    summary: 'Add reverb in the mixer and balance your sounds.',
    minutes: 3,
    steps: [
      {
        text: 'Open the Mixer: press F9, or its button on the right of the toolbar.',
        anchor: () => '[data-tour="windows"]',
        done: (s) => visible(s, 'mixer'),
      },
      {
        text: 'Click the Master track (the first one), then “+ Add effect” on the right, and choose Reverb.',
        anchor: () => '[data-window-type="mixer"]',
        done: (s) => (project(s).mixer.inserts[MASTER]?.fx ?? []).some((f) => f.plugin.pluginId === 'agstudio.reverb'),
      },
      {
        text: 'Make the reverb subtle: double-click its slot to open it, and drag Mix down to about 20%.',
        anchor: () => '[data-window-type="mixer"]',
        done: (s) =>
          (project(s).mixer.inserts[MASTER]?.fx ?? []).some(
            (f) => f.plugin.pluginId === 'agstudio.reverb' && Number(f.plugin.params.mix ?? 1) <= 0.25,
          ),
      },
      {
        text: 'Balance your sounds: drag the Clap’s volume knob in the channel rack a little lower.',
        anchor: (s) => row(s, 'Clap'),
        prepare: (s) => {
          const id = channelNamed(s, 'Clap');
          const c = id ? project(s).channels[id] : undefined;
          memo.volume = c && c.kind !== 'automation' ? c.volume : 0;
        },
        done: (s) => {
          const id = channelNamed(s, 'Clap');
          const c = id ? project(s).channels[id] : undefined;
          return !!c && c.kind !== 'automation' && c.volume < memo.volume - 0.02;
        },
      },
    ],
    next: 'That’s the whole loop. Ask the AI studio (✦) for anything else, or press ⌘K to find any action.',
  },
];
