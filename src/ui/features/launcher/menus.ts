/** The launcher's right-click menus: a slot, an empty slot, a track, a scene. */
import type { Services } from '@app/services';
import { clearSlotAt, editSlot, fillFromClips, putInSlotAt, type SlotSource } from '@app/launcher/edit';
import {
  MODE_HINTS,
  MODE_LABELS,
  QUANTIZE_LABELS,
  slotLabel,
  slotLoops,
  slotMode,
} from '@core/launcher/grid';
import { PALETTE } from '@core/model/defaults';
import {
  FOLLOW_KINDS,
  LAUNCH_MODES,
  LAUNCH_QUANTIZES,
  type FollowKind,
  type LaunchSlot,
  type LaunchTrackId,
  type Project,
  type SceneId,
} from '@core/model/types';
import {
  addLaunchTrack,
  addScene,
  recolorLaunchTrack,
  recolorScene,
  removeLaunchTrack,
  removeScene,
  renameLaunchTrack,
  renameScene,
  setTrackLane,
} from '@core/ops/launcher';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';
import { openWindow } from '../../workspace/registry';

const FOLLOW_LABELS: Record<FollowKind, string> = { next: 'Play the next slot', random: 'Play a random slot', stop: 'Stop' };
const FOLLOW_BARS = [1, 2, 4, 8, 16] as const;

async function rename(title: string, current: string): Promise<string | null> {
  const r = await showFormDialog({ title, fields: [{ kind: 'text', key: 'name', label: 'Name' }], values: { name: current }, okLabel: 'Rename' });
  const name = r?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

/** What the musician has at hand to put in a slot. */
function sources(s: Services, p: Project, ti: number, si: number): MenuEntry[] {
  const out: MenuEntry[] = [];
  const put = (src: SlotSource) => {
    const problem = putInSlotAt(s, ti, si, src);
    if (problem) s.session.getState().toast(problem, 'error');
  };
  const cur = s.view.getState().currentPatternId;
  if (cur && p.patterns[cur])
    out.push({
      label: `Put “${p.patterns[cur]!.name}” here`,
      hint: 'The pattern you are editing becomes this slot (the slot points at the pattern: edits to it are heard)',
      onSelect: () => put({ kind: 'pattern', patternId: cur }),
    });
  const sel = s.editor.getState().clipSelection;
  const clip = sel.map((id) => p.playlist.clips[id]).find((c) => c && c.kind !== 'automation');
  if (clip)
    out.push({
      label: 'Put the selected playlist clip here',
      hint: 'The pattern or audio of the clip you selected in the playlist becomes this slot',
      onSelect: () => put({ kind: 'clip', clipId: clip.id }),
    });
  out.push({
    kind: 'submenu',
    label: 'Put a pattern…',
    hint: 'Choose one of the project’s patterns for this slot',
    items: () =>
      p.patternOrder.map((id) => ({ label: p.patterns[id]!.name, onSelect: () => put({ kind: 'pattern', patternId: id }) })),
  });
  const audio = p.channelOrder.filter((id) => p.channels[id]?.kind === 'audioClip');
  if (audio.length)
    out.push({
      kind: 'submenu',
      label: 'Put an audio clip…',
      hint: 'Choose a sound (an audio clip channel) for this slot: it plays from the start and loops',
      items: () => audio.map((id) => ({ label: p.channels[id]!.name, onSelect: () => put({ kind: 'channel', channelId: id }) })),
    });
  return out;
}

export function slotMenu(s: Services, e: { clientX: number; clientY: number }, trackId: LaunchTrackId, sceneId: SceneId, ti: number, si: number): void {
  const p = s.doc.getState().project;
  const slot = p.launcher?.tracks[trackId]?.slots[sceneId];
  if (!slot) return showContextMenu(e, [{ kind: 'label', label: `Empty slot · track ${ti + 1}, scene ${si + 1}` }, ...sources(s, p, ti, si)]);
  showContextMenu(e, slotEntries(s, p, trackId, sceneId, slot, ti, si));
}

function slotEntries(s: Services, p: Project, trackId: LaunchTrackId, sceneId: SceneId, slot: LaunchSlot, ti: number, si: number): MenuEntry[] {
  const l = p.launcher!;
  const edit = (patch: Parameters<typeof editSlot>[3], label?: string) => editSlot(s, trackId, sceneId, patch, label);
  const quantizeOf = (q: (typeof LAUNCH_QUANTIZES)[number] | null) => (slot.quantize ?? null) === q;
  const follow = slot.follow;
  return [
    { kind: 'label', label: slotLabel(p, slot) },
    { icon: 'play', label: 'Launch', hint: 'Press this slot now (its mode and quantize apply)', onSelect: () => s.launcher.pressAt(ti, si) },
    ...(slot.content.kind === 'pattern'
      ? [
          {
            label: 'Edit the pattern',
            hint: 'Open this slot’s pattern in the piano roll',
            onSelect: () => {
              if (slot.content.kind === 'pattern') s.view.getState().setCurrentPattern(slot.content.patternId);
              openWindow(s, 'piano-roll');
            },
          } satisfies MenuEntry,
        ]
      : []),
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: `Launch mode: ${MODE_LABELS[slotMode(slot)]}`,
      hint: 'What a press does: trigger, toggle, gate or retrigger',
      items: LAUNCH_MODES.map((m) => ({
        label: MODE_LABELS[m],
        hint: MODE_HINTS[m],
        checked: slotMode(slot) === m,
        onSelect: () => edit({ mode: m }, 'Launcher slot mode'),
      })),
    },
    {
      label: 'Loop',
      hint: 'On: it repeats until stopped. Off: it plays once and stops',
      checked: slotLoops(slot),
      onSelect: () => edit({ loop: !slotLoops(slot) }, 'Launcher slot loop'),
    },
    {
      kind: 'submenu',
      label: `Quantize: ${slot.quantize ? QUANTIZE_LABELS[slot.quantize] : `grid (${QUANTIZE_LABELS[l.quantize]})`}`,
      hint: 'When this slot starts and stops after a press',
      items: [
        { label: `Grid default (${QUANTIZE_LABELS[l.quantize]})`, checked: quantizeOf(null), onSelect: () => edit({ quantize: null }, 'Launcher slot quantize') },
        ...LAUNCH_QUANTIZES.map((q) => ({ label: QUANTIZE_LABELS[q], checked: quantizeOf(q), onSelect: () => edit({ quantize: q }, 'Launcher slot quantize') })),
      ],
    },
    {
      kind: 'submenu',
      label: `Follow action: ${follow ? `${FOLLOW_LABELS[follow.kind].toLowerCase()} after ${follow.bars} bar${follow.bars === 1 ? '' : 's'}` : 'none'}`,
      hint: 'What happens after it has played for some bars: the next slot of the track, a random one, or stop',
      items: [
        { label: 'None', checked: !follow, onSelect: () => edit({ follow: null }, 'Launcher follow action') },
        ...FOLLOW_KINDS.map((k): MenuEntry => ({
          kind: 'submenu',
          label: FOLLOW_LABELS[k],
          items: FOLLOW_BARS.map((bars) => ({
            label: `after ${bars} bar${bars === 1 ? '' : 's'}`,
            checked: follow?.kind === k && follow.bars === bars,
            onSelect: () => edit({ follow: { kind: k, bars } }, 'Launcher follow action'),
          })),
        })),
      ],
    },
    { kind: 'separator' },
    {
      label: 'Rename…',
      hint: 'Give this slot its own name',
      onSelect: () =>
        void rename('Rename slot', slot.name ?? slotLabel(p, slot)).then((name) => {
          if (name) edit({ name }, 'Rename launcher slot');
        }),
    },
    { kind: 'swatches', colors: PALETTE, ...(slot.color ? { selected: slot.color } : {}), onSelect: (color) => edit({ color }, 'Launcher slot colour') },
    ...(slot.color || slot.name ? [{ label: 'Use the pattern’s name and colour', hint: 'Forget this slot’s own name and colour', onSelect: () => edit({ name: null, color: null }) } satisfies MenuEntry] : []),
    { kind: 'separator' },
    ...sources(s, p, ti, si),
    {
      label: 'Link to controller (MIDI learn)…',
      hint: 'Link a pad of your controller to this slot: click, then press the pad',
      onSelect: () => void s.commands.run('dj.controllers.learn', { target: `launch.slot:${ti + 1}:${si + 1}` }),
    },
    { kind: 'separator' },
    { label: 'Clear slot', danger: true, hint: 'Empty this slot (the pattern or audio is not deleted)', onSelect: () => clearSlotAt(s, trackId, sceneId) },
  ];
}

export function trackMenu(s: Services, e: { clientX: number; clientY: number }, trackId: LaunchTrackId, ti: number): void {
  const p = s.doc.getState().project;
  const t = p.launcher?.tracks[trackId];
  if (!t) return;
  const lanes = p.playlist.laneOrder;
  showContextMenu(e, [
    { kind: 'label', label: t.name },
    { icon: 'stop', label: 'Stop this track', hint: 'Stop what this track plays at the next boundary', onSelect: () => s.launcher.stopTrack(trackId) },
    { kind: 'separator' },
    {
      label: 'Rename…',
      onSelect: () =>
        void rename('Rename track', t.name).then((name) => {
          if (name) s.history.transact('Rename launcher track', (d) => renameLaunchTrack(d, trackId, name));
        }),
    },
    { kind: 'swatches', colors: PALETTE, ...(t.color ? { selected: t.color } : {}), onSelect: (c) => s.history.transact('Launcher track colour', (d) => recolorLaunchTrack(d, trackId, c)) },
    {
      kind: 'submenu',
      label: `Takes over playlist track: ${t.laneId && p.playlist.lanes[t.laneId] ? p.playlist.lanes[t.laneId]!.name : 'none'}`,
      hint: 'While a slot of this track plays, the playlist track you choose is silent (like FL’s Performance mode)',
      items: [
        { label: 'None', checked: !t.laneId, onSelect: () => s.history.transact('Launcher track playlist link', (d) => setTrackLane(d, trackId, null)) },
        ...lanes.map((id) => ({
          label: p.playlist.lanes[id]!.name,
          checked: t.laneId === id,
          onSelect: () => s.history.transact('Launcher track playlist link', (d) => setTrackLane(d, trackId, id)),
        })),
      ],
    },
    { kind: 'separator' },
    { label: 'Add a track', onSelect: () => s.history.transact('Add launcher track', (d) => void addLaunchTrack(d)) },
    {
      label: 'Delete this track',
      danger: true,
      disabled: (p.launcher?.trackOrder.length ?? 0) <= 1,
      hint: 'Remove this track and its slots (the patterns stay)',
      onSelect: () => {
        s.launcher.stopTrack(trackId, true);
        s.history.transact('Delete launcher track', (d) => removeLaunchTrack(d, trackId));
      },
    },
  ]);
  void ti;
}

export function sceneMenu(s: Services, e: { clientX: number; clientY: number }, sceneId: SceneId, si: number): void {
  const p = s.doc.getState().project;
  const sc = p.launcher?.scenes[sceneId];
  if (!sc) return;
  showContextMenu(e, [
    { kind: 'label', label: sc.name },
    { icon: 'play', label: 'Launch scene', hint: 'Launch every slot of this row together', onSelect: () => s.launcher.launchScene(sceneId) },
    { kind: 'separator' },
    {
      label: 'Rename…',
      onSelect: () =>
        void rename('Rename scene', sc.name).then((name) => {
          if (name) s.history.transact('Rename launcher scene', (d) => renameScene(d, sceneId, name));
        }),
    },
    { kind: 'swatches', colors: PALETTE, ...(sc.color ? { selected: sc.color } : {}), onSelect: (c) => s.history.transact('Launcher scene colour', (d) => recolorScene(d, sceneId, c)) },
    {
      label: 'Link to controller (MIDI learn)…',
      hint: 'Link a scene button of your controller: click, then press the button',
      onSelect: () => void s.commands.run('dj.controllers.learn', { target: `launch.scene:${si + 1}` }),
    },
    { kind: 'separator' },
    { label: 'Add a scene', onSelect: () => s.history.transact('Add launcher scene', (d) => void addScene(d)) },
    {
      label: 'Delete this scene',
      danger: true,
      disabled: (p.launcher?.sceneOrder.length ?? 0) <= 1,
      hint: 'Remove this row and its slots (the patterns stay)',
      onSelect: () => s.history.transact('Delete launcher scene', (d) => removeScene(d, sceneId)),
    },
  ]);
}

/** What the selected playlist clips could become, for the playlist clip menu. */
export function sendToLauncherEntry(s: Services, clipId: string): MenuEntry {
  return {
    label: 'Send to clip launcher',
    hint: 'Put this clip (or the selected clips) in free slots of the clip launcher, to launch it live',
    onSelect: () => {
      const sel = s.editor.getState().clipSelection;
      const ids = sel.includes(clipId as never) ? sel : [clipId as never];
      const r = fillFromClips(s, ids);
      openWindow(s, 'launcher');
      s.session.getState().toast(r.placed ? `Sent ${r.placed} clip${r.placed === 1 ? '' : 's'} to the clip launcher.` : 'Nothing to send: automation clips can’t be launched.', r.placed ? 'info' : 'error');
    },
  };
}
