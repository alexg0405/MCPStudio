import type { Services } from '@app/services';
import { clipSourceKey } from '@core/model/clips';
import { PALETTE, makeLane } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { Clip, LaneId } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import {
  addLane,
  editClips,
  makeClipUnique,
  removeClips,
  removeLane,
  setLaneProps,
  setPatternProps,
  toggleSoloLane,
} from '@core/ops/playlist';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { openWindow } from '../../workspace/registry';

/** A clip's ▾ menu (FL's clip menu), with what other features add for clips. */
export function clipMenu(s: Services, clip: Clip): MenuEntry[] {
  return [...baseClipMenu(s, clip), ...extraMenuItems('playlist.clip', { clip }, s)];
}

function baseClipMenu(s: Services, clip: Clip): MenuEntry[] {
  const p = s.doc.getState().project;
  const source = clipSourceKey(clip);
  const same = (c: Clip) => clipSourceKey(c) === source;
  const common: MenuEntry[] = [
    {
      label: clip.kind === 'pattern' ? 'Select all clips of this pattern' : 'Select all clips of this sound',
      onSelect: () =>
        s.editor.getState().selectClips(
          Object.values(p.playlist.clips)
            .filter(same)
            .map((c) => c.id),
        ),
    },
    { kind: 'separator' },
    {
      label: clip.muted ? 'Unmute clip' : 'Mute clip',
      onSelect: () =>
        s.history.transact(clip.muted ? 'Unmute clip' : 'Mute clip', (d) =>
          editClips(d, [{ id: clip.id, muted: !clip.muted }]),
        ),
    },
    {
      label: 'Delete clip',
      danger: true,
      onSelect: () => s.history.transact('Delete clip', (d) => removeClips(d, [clip.id])),
    },
  ];
  if (clip.kind === 'pattern') {
    const pattern = p.patterns[clip.patternId];
    if (!pattern) return common;
    const uses = Object.values(p.playlist.clips).filter(same).length;
    return [
      { kind: 'label', label: pattern.name },
      {
        label: 'Edit pattern',
        onSelect: () => {
          s.view.getState().setCurrentPattern(pattern.id);
          openWindow(s, 'channel-rack');
        },
      },
      {
        kind: 'swatches',
        colors: PALETTE,
        selected: pattern.color,
        onSelect: (color) => s.history.transact('Pattern color', (d) => setPatternProps(d, pattern.id, { color })),
      },
      {
        label: 'Make unique',
        disabled: uses < 2,
        onSelect: () => {
          const copy = newId.pattern();
          s.history.transact('Make unique', (d) => makeClipUnique(d, clip.id, copy, `${pattern.name} #2`));
          s.view.getState().setCurrentPattern(copy);
        },
      },
      ...common,
    ];
  }
  const channel = p.channels[clip.channelId];
  return [
    { kind: 'label', label: channel?.name ?? 'Audio clip' },
    ...(channel
      ? [
          {
            kind: 'swatches' as const,
            colors: PALETTE,
            selected: channel.color,
            onSelect: (color: string) =>
              s.history.transact('Clip color', (d) => setChannelProp(d, channel.id, 'color', color)),
          },
        ]
      : []),
    ...common,
  ];
}

/** Right-click on a track name. */
export function laneMenu(s: Services, laneId: LaneId, rename: () => void): MenuEntry[] {
  const base = baseLaneMenu(s, laneId, rename);
  return base.length ? [...base, ...extraMenuItems('playlist.lane', { laneId }, s)] : base;
}

function baseLaneMenu(s: Services, laneId: LaneId, rename: () => void): MenuEntry[] {
  const p = s.doc.getState().project;
  const lane = p.playlist.lanes[laneId];
  if (!lane) return [];
  const index = p.playlist.laneOrder.indexOf(laneId);
  return [
    { kind: 'label', label: lane.name },
    { label: 'Rename…', onSelect: rename },
    {
      label: lane.muted ? 'Unmute track' : 'Mute track',
      onSelect: () =>
        s.history.transact(lane.muted ? 'Unmute track' : 'Mute track', (d) =>
          setLaneProps(d, laneId, { muted: !lane.muted }),
        ),
    },
    {
      label: lane.solo ? 'Unsolo track' : 'Solo track',
      onSelect: () => s.history.transact('Solo track', (d) => toggleSoloLane(d, laneId)),
    },
    {
      label: 'Select all clips on this track',
      onSelect: () =>
        s.editor.getState().selectClips(
          Object.values(p.playlist.clips)
            .filter((c) => c.laneId === laneId)
            .map((c) => c.id),
        ),
    },
    { kind: 'separator' },
    {
      label: 'Insert track above',
      onSelect: () =>
        s.history.transact('Insert track', (d) =>
          addLane(d, makeLane(`Track ${d.playlist.laneOrder.length + 1}`), index),
        ),
    },
    {
      label: 'Delete track',
      danger: true,
      disabled: p.playlist.laneOrder.length <= 1,
      onSelect: () => s.history.transact(`Delete ${lane.name}`, (d) => removeLane(d, laneId)),
    },
  ];
}
