/** Playlist markers in the UI: right-click menus and the "rename this marker now" request. */
import { createStore } from 'zustand/vanilla';
import type { Services } from '@app/services';
import {
  addMarkerAt,
  deleteMarker,
  describeMarker,
  jumpTo,
  jumpToMarker,
  loopToNextMarker,
  markerSection,
} from '@app/actions/markers';
import { PALETTE } from '@core/model/defaults';
import type { MarkerId, Tick } from '@core/model/types';
import { markersSorted, recolorMarker } from '@core/ops/markers';
import { formatBST } from '@core/time/ppq';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';

/** A marker to rename inline on the ruler (Alt+T asks for a name right away); the playlist takes it. */
export const markerRename = createStore<{ id: MarkerId | null }>(() => ({ id: null }));

/** Right-click on a marker. */
export function markerMenu(s: Services, id: MarkerId): MenuEntry[] {
  const p = s.doc.getState().project;
  const m = p.playlist.markers[id];
  if (!m) return [];
  const next = markersSorted(p).find((x) => x.tick > m.tick);
  return [
    { kind: 'label', label: `Marker: ${describeMarker(s, m)}` },
    {
      icon: 'play',
      label: 'Play this section',
      hint: 'Loop the part from this marker to the next one and play it',
      disabled: !markerSection(s, id),
      onSelect: () => {
        const r = markerSection(s, id);
        if (r) s.commands.run('transport.playRange', r);
      },
    },
    { label: 'Jump here', hint: 'Set the song position to this marker', onSelect: () => jumpToMarker(s, id) },
    {
      label: 'Rename…',
      hint: 'Type a new name (or double-click the marker)',
      onSelect: () => markerRename.setState({ id }),
    },
    {
      label: next ? `Loop this section (to ${next.name})` : 'Loop this section (to the end of the song)',
      hint: 'Set the loop region from this marker to the next one, so playback repeats that part',
      onSelect: () => void loopToNextMarker(s, id),
    },
    {
      kind: 'swatches',
      colors: PALETTE,
      selected: m.color,
      onSelect: (color) => s.history.transact('Marker color', (d) => recolorMarker(d, id, color)),
    },
    ...extraMenuItems('playlist.marker', { markerId: id }, s),
    { kind: 'separator' },
    { label: 'Delete marker', danger: true, onSelect: () => deleteMarker(s, id) },
  ];
}

/** Right-click on an empty spot of the ruler. */
export function rulerMenu(s: Services, tick: Tick): MenuEntry[] {
  const ts = s.doc.getState().project.transport.timeSig;
  const loop = s.view.getState().loop;
  return [
    {
      label: `Add marker here (${formatBST(tick, ts)})`,
      hint: 'A named song position, like “Verse” or “Drop”: you can jump to it and loop between markers',
      onSelect: () => markerRename.setState({ id: addMarkerAt(s, tick) }),
    },
    {
      label: 'Add marker at the song position',
      shortcut: 'Alt+T',
      onSelect: () => void s.commands.run('playlist.addMarker'),
    },
    { kind: 'separator' },
    {
      icon: 'play',
      label: 'Play from here',
      hint: 'Play the song from this position (a loop region that does not include it is cleared)',
      onSelect: () => void s.commands.run('transport.playFrom', { tick }),
    },
    { label: 'Set the song position here', onSelect: () => jumpTo(s, tick) },
    {
      label: 'Clear the loop region',
      disabled: !loop,
      hint: loop ? 'Play the whole song again (or double-click the ruler)' : 'There is no loop region',
      onSelect: () => s.view.getState().setLoop(null),
    },
    ...extraMenuItems('playlist.ruler', { tick }, s),
  ];
}
