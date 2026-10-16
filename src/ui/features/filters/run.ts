/**
 * Running sound filters from the UI (menus, the chooser, the action search): which part a click
 * means, the "Filter … ▸" submenu, and applying with a toast and playback from a bar before.
 */
import type { Services } from '@app/services';
import { applyFilter, playFrom, removeFilter } from '@app/filters/apply';
import { FILTERS, lengthNote, type FilterPreset } from '@core/filters/presets';
import { clipsTarget, defaultTarget, rangeTarget, songTarget, targetLabel, targetPlays, type FilterTarget } from '@core/filters/target';
import type { ChannelId } from '@core/model/types';
import { filterChannelOf } from '@core/ops/filters';
import type { MenuEntry } from '../../controls/ContextMenu';

let busy = false;

/** The usual target: the selected clips, else the loop region, else the whole song. */
export function currentTarget(s: Services): FilterTarget | null {
  return defaultTarget(s.doc.getState().project, {
    selection: s.editor.getState().clipSelection,
    loop: s.view.getState().loop,
  });
}

/** The parts the chooser offers: the selection, the loop region and the whole song (those that exist). */
export function targetChoices(s: Services): { target: FilterTarget; label: string }[] {
  const p = s.doc.getState().project;
  const out: { target: FilterTarget; label: string }[] = [];
  const sel = clipsTarget(p, s.editor.getState().clipSelection);
  if (sel) out.push({ target: sel, label: `The selected clips (${targetLabel(p, sel)})` });
  const loop = s.view.getState().loop;
  const range = loop ? rangeTarget(p, loop.start, loop.end) : null;
  if (range && range.kind === 'range') out.push({ target: range, label: `The loop region (${targetLabel(p, range)})` });
  const song = songTarget(p);
  if (song) out.push({ target: song, label: 'The whole song' });
  return out;
}

/** The hint of a filter on a part. */
export function filterHint(f: FilterPreset, where: string): string {
  return `${f.name}: ${f.description}, on ${where}. ${lengthNote(f)} Undo or Remove filter brings the original back.`;
}

/** Renders the part, applies the filter (one undo step), says what it did and plays from a bar before. */
export async function runFilter(s: Services, filterId: string, target: FilterTarget | null): Promise<void> {
  const toast = s.session.getState().toast;
  if (!target) {
    toast('There is nothing to filter yet: put something on the playlist first.');
    return;
  }
  if (busy) {
    toast('A filter is still rendering: wait for it to finish.');
    return;
  }
  const f = FILTERS.find((x) => x.id === filterId);
  busy = true;
  toast(`Rendering ${targetLabel(s.doc.getState().project, target)} for ${f?.name ?? filterId}…`);
  try {
    const res = await applyFilter(s, filterId, target);
    toast(`${res.message}. Undo or Remove filter brings the original back.`);
    playFrom(s, res.from);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy = false;
  }
}

/** Removes a filter by its channel, with a toast. */
export function runRemoveFilter(s: Services, channelId: ChannelId): void {
  const res = removeFilter(s, channelId);
  s.session.getState().toast(res.message, res.ok ? 'info' : 'error');
}

/** "Filter bars 17–32 ▸" with the speed and tone filters (nothing when nothing plays there). */
export function filterMenu(s: Services, target: FilterTarget | null): MenuEntry[] {
  const p = s.doc.getState().project;
  if (!target || !targetPlays(p, target)) return [];
  const where = targetLabel(p, target);
  const item = (f: FilterPreset): MenuEntry => ({
    label: f.name,
    hint: filterHint(f, where),
    onSelect: () => void runFilter(s, f.id, target),
  });
  return [
    {
      kind: 'submenu',
      label: `Filter ${where}`,
      hint: `Play ${where} through a sound filter (Nightcore, slowed + reverb, telephone, lo-fi…): rendered to audio, one undo step`,
      items: () => [
        { kind: 'label', label: 'Speed and pitch' },
        ...FILTERS.filter((f) => f.group === 'speed').map(item),
        { kind: 'separator' },
        { kind: 'label', label: 'Tone' },
        ...FILTERS.filter((f) => f.group === 'tone').map(item),
      ],
    },
  ];
}

/** "Remove filter" for a filtered clip (nothing for other clips). */
export function removeFilterMenu(s: Services, clipId: string): MenuEntry[] {
  const p = s.doc.getState().project;
  const ch = filterChannelOf(p, p.playlist.clips[clipId as keyof typeof p.playlist.clips]);
  if (!ch) return [];
  return [
    {
      label: 'Remove filter',
      hint: `Deletes “${ch.name}” and puts back the clips it replaced, exactly as they were (one undo step)`,
      onSelect: () => runRemoveFilter(s, ch.id),
    },
  ];
}
