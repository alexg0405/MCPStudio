import type { Services } from '@app/services';
import { songPosition } from '@app/actions/markers';
import { addFillAt, addTransitionAt, developSong, refreshVariations, type CommandResult } from '@app/arrange/commands';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import type { MarkerId, Tick } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { MenuEntry } from '../../controls/ContextMenu';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd, sep } from '../../shell/menus';

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

/** Says what an arranger command did. */
function report(s: Services, r: CommandResult): void {
  s.session.getState().toast(r.message, r.error ? 'error' : 'info');
}

const where = (s: Services, range: { from: Tick; to: Tick } | null) =>
  range ? barSpan(range.from, range.to, s.doc.getState().project.transport.timeSig) : 'the whole song';

/**
 * The arranger without the AI (Playlist menu, marker and ruler right-click): develop a part with
 * fills and transitions, add a fill or a transition at a spot, refresh variations after editing a
 * source pattern. Each is one undo step and says what it did in a toast.
 */
export function register(services: Services): void {
  const { commands } = services;
  const hasSong = (s: Services) => Object.keys(s.doc.getState().project.playlist.clips).length > 0;
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
      report(s, developSong(s, range));
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
    run: (s, args) => report(s, addFillAt(s, args?.tick ?? songPosition(s))),
  });
  commands.register<{ tick?: number } | undefined>({
    id: 'arrange.addTransition',
    title: 'Add a transition here',
    category: 'Playlist',
    hint: 'The transition the sections call for, into the bar at the song position: a gap and riser before a drop, a downlifter into a break, a fill and a crash',
    argsHint: 'optional { tick }',
    ai: false,
    enabled: hasSong,
    run: (s, args) => report(s, addTransitionAt(s, args?.tick ?? songPosition(s))),
  });
  commands.register({
    id: 'arrange.refresh',
    title: 'Refresh variations',
    category: 'Playlist',
    hint: 'Rebuild the fills and variations (patterns named “Beat · fill”) from their source patterns after you edited a source; ones you edited by hand stay as they are',
    ai: false,
    enabled: (s) => Object.values(s.doc.getState().project.patterns).some((x) => x.derived),
    run: (s) => report(s, refreshVariations(s)),
  });
  addMenuItems('playlist', [
    sep(55),
    cmd('arrange.develop', 56),
    cmd('arrange.addFill', 57),
    cmd('arrange.addTransition', 58),
    cmd('arrange.refresh', 59),
  ]);

  const bar = () => ticksPerBar(services.doc.getState().project.transport.timeSig);
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
              onSelect: () => report(s, developSong(s, { from: sec.from, to: sec.to })),
            },
          ]
        : []),
      {
        label: `Add a transition into “${m.name}”`,
        hint: 'The transition its energy calls for: a gap, riser and impact into a drop, a downlifter into a break, a fill and a crash',
        onSelect: () => report(s, addTransitionAt(s, m.tick)),
      },
    ];
  });
  /** A fill at the end of the bar at `tick`, a transition into the nearest bar line. */
  const atSpot = (s: Services, tick: Tick): MenuEntry[] => {
    const b = Math.floor(tick / bar());
    const into = Math.round(tick / bar());
    return [
      {
        label: `Add a fill here (end of bar ${b + 1})`,
        hint: 'A 2-beat fill that replaces the drums at the end of this bar',
        onSelect: () => report(s, addFillAt(s, tick)),
      },
      {
        label: `Add a transition here (into bar ${into + 1})`,
        hint: 'The transition the sections on either side call for',
        onSelect: () => report(s, addTransitionAt(s, into * bar())),
      },
    ];
  };
  addContextMenuItems('playlist.empty', ({ tick }, s) => (hasSong(s) ? atSpot(s, tick) : []));
  addContextMenuItems('playlist.ruler', ({ tick }: { tick: Tick }, s): MenuEntry[] => {
    const range = developRange(s);
    return [
      ...atSpot(s, tick),
      {
        label: `Develop ${where(s, range)} (fills, transitions)`,
        hint: 'Fills every 8 bars, changes every 4 and transitions between sections, one undo step',
        onSelect: () => report(s, developSong(s, range)),
      },
    ];
  });
  addContextMenuItems('playlist.clip', ({ clip }, s): MenuEntry[] => {
    if (clip.kind !== 'pattern') return [];
    const end = clip.start + clip.length;
    return [
      {
        label: 'Add a fill at the end of this clip',
        hint: 'A 2-beat fill replacing the drums in its last beats (the clip plays a variant of its pattern)',
        onSelect: () => report(s, addFillAt(s, end - 1)),
      },
      {
        label: 'Add a transition after this clip',
        hint: 'The transition into the bar after it',
        onSelect: () => report(s, addTransitionAt(s, end)),
      },
    ];
  });
}
