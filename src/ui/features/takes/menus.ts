/** The take entries of the playlist's clip and track menus, and the crossfade dialog. */
import { compTarget, setCrossfade } from '@app/actions/comp';
import type { Services } from '@app/services';
import { MAX_CROSSFADE_MS } from '@core/audio/comp';
import type { Clip, LaneId } from '@core/model/types';
import { groupOfLane } from '@core/query/takes';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';

/** Asks how long two takes fade across each other where the comp changes take, and applies it. */
export async function crossfadeDialog(s: Services, groupId: string, current: number): Promise<void> {
  const values = await showFormDialog({
    title: 'Comp crossfade',
    message: 'Where two takes meet, they fade across each other (equal power, centred on the cut) instead of clicking. Shorter keeps the attack of a word; longer hides a cut in a sustained note.',
    fields: [{ kind: 'number', key: 'ms', label: 'Crossfade', min: 0, max: MAX_CROSSFADE_MS, step: 1, unit: 'ms' }],
    values: { ms: current },
    okLabel: 'Apply',
  });
  if (values) setCrossfade(s, groupId, Number(values.ms));
}

function listenLabel(isHeard: boolean, isTake: boolean): string {
  if (isHeard) return 'Stop listening to this take';
  return isTake ? 'Listen to this take' : 'Listen to the take this plays';
}

/** The "Listen to this take" entry, worded for what the clip is. */
function listenEntry(s: Services, clip: Clip & { kind: 'audio' }, isTake: boolean): MenuEntry {
  const isHeard = s.editor.getState().auditionTake === clip.id;
  return {
    label: listenLabel(isHeard, isTake),
    shortcut: 'Alt+L',
    hint: 'Hear this one take on its own, without unmuting it (the comp and the other takes go quiet); the project is not changed. Choose it again to go back to the comp',
    onSelect: () => void s.commands.run('comp.listenTake', { clip: clip.id }),
  };
}

/** The take entries of a clip's menu. */
export function takeClipMenu(s: Services, clip: Clip): MenuEntry[] {
  if (clip.kind !== 'audio' || !clip.take) return [];
  const target = compTarget(s, { clip: clip.id });
  if (!target) return [];
  const isTake = !clip.take.comp;
  const isOpen = s.editor.getState().openTakes.includes(target.group.id);
  return [
    listenEntry(s, clip, isTake),
    ...(isTake
      ? [
          {
            label: 'Use this take',
            hint: 'The comp track plays this whole take (replaces what it plays now); drag across a take with the Comp tool to use only a part',
            onSelect: () => void s.commands.run('comp.useTake', { clip: clip.id }),
          },
        ]
      : []),
    {
      label: 'Next take here',
      shortcut: ']',
      hint: 'Swap this part of the comp for the next take (it goes round)',
      onSelect: () => void s.commands.run('comp.nextTake', { clip: clip.id }),
    },
    {
      label: 'Previous take here',
      shortcut: '[',
      hint: 'Swap this part of the comp for the previous take',
      onSelect: () => void s.commands.run('comp.previousTake', { clip: clip.id }),
    },
    {
      label: isOpen ? 'Fold the takes' : 'Open the takes',
      hint: 'Show or hide the take tracks under the comp track',
      onSelect: () => void s.commands.run('comp.toggleTakes', { clip: clip.id }),
    },
    {
      label: 'Flatten comp',
      hint: 'Keep what the comp plays as ordinary clips and delete the take tracks (undo brings them back)',
      onSelect: () => void s.commands.run('comp.flatten', { clip: clip.id }),
    },
    {
      label: 'Flatten and merge into one clip',
      hint: 'Render the comp into one new clip (crossfades included) and delete the take tracks',
      onSelect: () => void s.commands.run('comp.flatten', { clip: clip.id, merge: true }),
    },
  ];
}

/** The take entries of a track's menu. */
export function takeLaneMenu(s: Services, laneId: LaneId): MenuEntry[] {
  const group = groupOfLane(s.doc.getState().project, laneId);
  if (!group) return [];
  const isOpen = s.editor.getState().openTakes.includes(group.id);
  return [
    {
      label: isOpen ? 'Fold the takes' : 'Open the takes',
      hint: 'Show or hide the take tracks under the comp track',
      onSelect: () => void s.commands.run('comp.toggleTakes', { group: group.id }),
    },
    {
      label: `Comp crossfade… (${group.crossfadeMs} ms)`,
      hint: 'How long two takes fade across each other where the comp changes take',
      onSelect: () => void crossfadeDialog(s, group.id, group.crossfadeMs),
    },
    {
      label: 'Flatten comp',
      hint: 'Keep what the comp plays as ordinary clips and delete the take tracks (undo brings them back)',
      onSelect: () => void s.commands.run('comp.flatten', { group: group.id }),
    },
    {
      label: 'Flatten and merge into one clip',
      hint: 'Render the comp into one new clip (crossfades included) and delete the take tracks',
      onSelect: () => void s.commands.run('comp.flatten', { group: group.id, merge: true }),
    },
  ];
}
