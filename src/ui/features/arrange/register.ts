import type { Services } from '@app/services';
import { songPosition } from '@app/actions/markers';
import type { CommandResult } from '@app/arrange/commands';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import type { MarkerId, Tick } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { MenuEntry } from '../../controls/ContextMenu';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { whenIdle } from '../../workspace/lazy';

/** The part a "develop" means: the loop region, else the selected clips' bounds, else the whole song (null). */
export function developRange(s: Services): { from: Tick; to: Tick } | null {
  const loop = s.view.getState().loop;
  if (loop && loop.end > loop.start) return { from: loop.start, to: loop.end };
  const p = s.doc.getState().project;
  const sel = s.editor
    .getState()
    .clipSelection.map((id) => p.playlist.clips[id])
    .filter((c) => !!c);
  if (sel.length) {
    const bar = ticksPerBar(p.transport.timeSig);
    const from = Math.floor(Math.min(...sel.map((c) => c.start)) / bar) * bar;
    const to = Math.ceil(Math.max(...sel.map((c) => c.start + c.length)) / bar) * bar;
    return { from, to };
  }
  return null;
}

/**
 * The arranger's code (it builds fills, transitions and a mix) loads the first time one of its commands
 * runs, and is fetched at idle time after the first paint, so it is not part of startup.
 */
const arranger = () => import('@app/arrange/commands');
type Arranger = Awaited<ReturnType<typeof arranger>>;
whenIdle(() => void arranger());

/** Runs an arranger command and says what it did. */
async function arrange(s: Services, run: (m: Arranger) => CommandResult): Promise<void> {
  const r = run(await arranger());
  s.session.getState().toast(r.message, r.error ? 'error' : 'info');
}

const where = (s: Services, range: { from: Tick; to: Tick } | null) =>
  range ? barSpan(range.from, range.to, s.doc.getState().project.transport.timeSig) : 'the whole song';

/** Whether the song has any clip (a fill or transition needs something to build on). */
const hasSong = (s: Services) => Object.keys(s.doc.getState().project.playlist.clips).length > 0;

/** Ticks in one bar of the song. */
const barTicks = (s: Services) => ticksPerBar(s.doc.getState().project.transport.timeSig);

/** A fill at the end of the bar at `tick`, a transition into the nearest bar line. */
function fillAndTransitionHere(s: Services, tick: Tick): MenuEntry[] {
  const bar = barTicks(s);
  const fillBar = Math.floor(tick / bar);
  const transitionBar = Math.round(tick / bar);
  return [
    {
      label: `Add a fill here (end of bar ${fillBar + 1})`,
      hint: 'A 2-beat fill that replaces the drums at the end of this bar',
      onSelect: () => void arrange(s, (m) => m.addFillAt(s, tick)),
    },
    {
      label: `Add a transition here (into bar ${transitionBar + 1})`,
      hint: 'The transition the sections on either side call for',
      onSelect: () => void arrange(s, (m) => m.addTransitionAt(s, transitionBar * bar)),
    },
  ];
}

/**
 * The arranger without the AI (Playlist menu, marker and ruler right-click): develop a part with
 * fills and transitions, add a fill or a transition at a spot, refresh variations after editing a
 * source pattern. Each is one undo step and says what it did in a toast.
 */
export function register(services: Services): void {
  registerArrangeCommands(services);
  registerArrangeMenus();
  registerMarkerMenu();
  registerSpotMenus();
  registerClipMenu();
}

/** The arranger commands: develop a part, add a fill, add a transition, refresh variations; each is one undo step. */
function registerArrangeCommands({ commands }: Services): void {
  commands.register<{ from?: number; to?: number } | undefined>({
    id: 'arrange.develop',
    title: 'Develop this part (fills, transitions)',
    category: 'Playlist',
    hint: 'Fills every 8 bars and changes every 4, gaps before drops, risers, impacts, crashes and filter sweeps between sections, for the loop region or selected clips (else the whole song). One undo step.',
    argsHint: 'optional { from, to } in ticks',
    ai: false,
    enabled: hasSong,
    run: (s, args) => {
      const range = args?.from !== undefined && args.to !== undefined ? { from: args.from, to: args.to } : developRange(s);
      return arrange(s, (m) => m.developSong(s, range));
    },
  });
  commands.register<{ tick?: number } | undefined>({
    id: 'arrange.addFill',
    title: 'Add a fill here',
    category: 'Playlist',
    hint: 'A 2-beat fill that replaces the drums at the end of the bar at the song position (it becomes a variant of that clip’s pattern)',
    argsHint: 'optional { tick }',
    ai: false,
    enabled: hasSong,
    run: (s, args) => arrange(s, (m) => m.addFillAt(s, args?.tick ?? songPosition(s))),
  });
  commands.register<{ tick?: number } | undefined>({
    id: 'arrange.addTransition',
    title: 'Add a transition here',
    category: 'Playlist',
    hint: 'The transition the sections call for, into the bar at the song position: a gap and riser before a drop, a downlifter into a break, a fill and a crash',
    argsHint: 'optional { tick }',
    ai: false,
    enabled: hasSong,
    run: (s, args) => arrange(s, (m) => m.addTransitionAt(s, args?.tick ?? songPosition(s))),
  });
  commands.register({
    id: 'arrange.refresh',
    title: 'Refresh variations',
    category: 'Playlist',
    hint: 'Rebuild the fills and variations (patterns named “Beat · fill”) from their source patterns after you edited a source; ones you edited by hand stay as they are',
    ai: false,
    enabled: (s) => Object.values(s.doc.getState().project.patterns).some((x) => x.derived),
    run: (s) => arrange(s, (m) => m.refreshVariations(s)),
  });
}

/** The Playlist menu entries for the arranger commands. */
function registerArrangeMenus(): void {
  addMenuItems('playlist', [
    sep(55),
    cmd('arrange.develop', 56),
    cmd('arrange.addFill', 57),
    cmd('arrange.addTransition', 58),
    cmd('arrange.refresh', 59),
  ]);
}

/** Right-click a marker: develop its section, add a transition into it. */
function registerMarkerMenu(): void {
  addContextMenuItems('playlist.marker', ({ markerId }: { markerId: MarkerId }, s): MenuEntry[] => {
    const p = s.doc.getState().project;
    const sec = songSections(p).find((x) => x.markerId === markerId);
    const m = p.playlist.markers[markerId];
    if (!m) return [];
    return [
      ...(sec
        ? [
            {
              label: `Develop “${sec.name}” (fills, transitions)`,
              hint: `Fills, changes and transitions for ${barSpan(sec.from, sec.to, p.transport.timeSig)}, one undo step`,
              onSelect: () => void arrange(s, (m) => m.developSong(s, { from: sec.from, to: sec.to })),
            },
          ]
        : []),
      {
        label: `Add a transition into “${m.name}”`,
        hint: 'The transition its energy calls for: a gap, riser and impact into a drop, a downlifter into a break, a fill and a crash',
        onSelect: () => void arrange(s, (a) => a.addTransitionAt(s, m.tick)),
      },
    ];
  });
}

/** Right-click empty playlist space or the ruler: a fill or transition at that spot, and develop the part. */
function registerSpotMenus(): void {
  addContextMenuItems('playlist.empty', ({ tick }, s) => (hasSong(s) ? fillAndTransitionHere(s, tick) : []));
  addContextMenuItems('playlist.ruler', ({ tick }: { tick: Tick }, s): MenuEntry[] => {
    const range = developRange(s);
    return [
      ...fillAndTransitionHere(s, tick),
      {
        label: `Develop ${where(s, range)} (fills, transitions)`,
        hint: 'Fills every 8 bars, changes every 4 and transitions between sections, one undo step',
        onSelect: () => void arrange(s, (m) => m.developSong(s, range)),
      },
    ];
  });
}

/** Right-click a pattern clip: a fill at its end, a transition after it. */
function registerClipMenu(): void {
  addContextMenuItems('playlist.clip', ({ clip }, s): MenuEntry[] => {
    if (clip.kind !== 'pattern') return [];
    const end = clip.start + clip.length;
    return [
      {
        label: 'Add a fill at the end of this clip',
        hint: 'A 2-beat fill replacing the drums in its last beats (the clip plays a variant of its pattern)',
        onSelect: () => void arrange(s, (m) => m.addFillAt(s, end - 1)),
      },
      {
        label: 'Add a transition after this clip',
        hint: 'The transition into the bar after it',
        onSelect: () => void arrange(s, (m) => m.addTransitionAt(s, end)),
      },
    ];
  });
}
