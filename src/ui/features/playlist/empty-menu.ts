/**
 * The menu a click on an empty spot of the playlist opens (draw tool): place a pattern, paste, add a
 * marker, name the track, and what other features add for the spot ('playlist.empty': ask Studio
 * about the bar, a fill or a transition…). Dragging on an empty spot still places the current pattern.
 */
import type { Services } from '@app/services';
import { addMarkerAt } from '@app/actions/markers';
import { newPattern } from '@app/actions/patterns';
import { newId } from '@core/model/ids';
import type { ClipId, LaneId, PatternId, Tick } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { patternClipLength } from '@core/query/playlist';
import { formatBST, ticksPerBar } from '@core/time/ppq';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { openWindow } from '../../workspace/registry';
import { playlistCommands } from './commands';
import { markerRename } from './markers';

/** Places a pattern at a spot (one undo step); it becomes the current pattern and the new clip is selected. */
export function placePatternAt(s: Services, patternId: PatternId, laneId: LaneId, tick: Tick): ClipId | null {
  const p = s.doc.getState().project;
  const pattern = p.patterns[patternId];
  if (!pattern || !p.playlist.lanes[laneId]) return null;
  const id = newId.clip();
  const length = patternClipLength(p, patternId);
  s.history.transact(`Place ${pattern.name}`, (d) =>
    addClips(d, [{ kind: 'pattern', id, laneId, start: Math.max(0, tick), length, patternId, offset: 0 }]),
  );
  s.view.getState().setCurrentPattern(patternId);
  s.editor.getState().selectClips([id]);
  return id;
}

/** The empty-spot menu at `tick` (already snapped) on a track; empty when the track is gone. */
export function emptyMenu(s: Services, tick: Tick, laneId: LaneId, rename: () => void): MenuEntry[] {
  const p = s.doc.getState().project;
  const lane = p.playlist.lanes[laneId];
  if (!lane) return [];
  const ts = p.transport.timeSig;
  const bar = Math.floor(tick / ticksPerBar(ts)) + 1;
  const currentId = s.view.getState().currentPatternId;
  const current = currentId ? p.patterns[currentId] : undefined;
  const patterns = p.patternOrder.map((id) => p.patterns[id]).filter((x) => !!x);
  const clipboard = s.editor.getState().clipClipboard ?? [];
  const place: MenuEntry = current
    ? {
        icon: 'plus',
        label: `Place “${current.name}” here`,
        hint: `Put the current pattern on ${lane.name} at bar ${bar} (dragging on an empty spot does this too)`,
        onSelect: () => void placePatternAt(s, current.id, laneId, tick),
      }
    : {
        icon: 'plus',
        label: 'Place the current pattern here',
        disabled: true,
        hint: 'There is no current pattern: make one with “Place a pattern… → New pattern”',
        onSelect: () => {},
      };
  return [
    { kind: 'label', label: `${lane.name} · bar ${bar}` },
    place,
    {
      kind: 'submenu',
      label: 'Place a pattern…',
      hint: 'Pick which pattern to put here (or start a new, empty one)',
      items: () => [
        ...patterns.map(
          (pat): MenuEntry => ({
            label: pat.name,
            checked: pat.id === currentId,
            hint: `Put “${pat.name}” on ${lane.name} at bar ${bar}`,
            onSelect: () => void placePatternAt(s, pat.id, laneId, tick),
          }),
        ),
        ...(patterns.length ? [{ kind: 'separator' } as const] : []),
        {
          icon: 'plus',
          label: 'New pattern',
          hint: 'Make a new, empty pattern, put it here and open the channel rack to fill it',
          onSelect: () => {
            const id = newPattern(s);
            placePatternAt(s, id, laneId, tick);
            openWindow(s, 'channel-rack');
          },
        },
      ],
    },
    {
      icon: 'play',
      label: `Play from bar ${bar}`,
      hint: `Play the song from the start of bar ${bar} (a loop region that does not include it is cleared)`,
      onSelect: () => void s.commands.run('transport.playFrom', { bar }),
    },
    ...(clipboard.length
      ? [
          {
            label: clipboard.length > 1 ? `Paste ${clipboard.length} clips here` : 'Paste here',
            hint: `Paste the copied clips starting at bar ${bar} on ${lane.name}`,
            onSelect: () => void playlistCommands.pasteAt(s, tick, laneId),
          },
        ]
      : []),
    ...extraMenuItems('playlist.empty', { tick, laneId }, s),
    { kind: 'separator' },
    {
      label: `Add a marker here (${formatBST(tick, ts)})`,
      hint: 'A named song position, like “Verse” or “Drop”: you can jump to it and loop between markers',
      onSelect: () => markerRename.setState({ id: addMarkerAt(s, tick) }),
    },
    {
      label: 'Name this track…',
      hint: `Rename “${lane.name}” (or double-click its name)`,
      onSelect: rename,
    },
  ];
}
