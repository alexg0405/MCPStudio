import type { Services } from '@app/services';
import { FILTERS, findFilter } from '@core/filters/presets';
import { clipsTarget, markerTarget, rangeTarget, spotTarget, targetLabel, type FilterTarget } from '@core/filters/target';
import type { ChannelId } from '@core/model/types';
import { filterChannelOf } from '@core/ops/filters';
import { addContextMenuItems } from '../../context-menus';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { FilterOverlay } from './FilterDialog';
import { filterStore } from './filter-store';
import { currentTarget, filterHint, filterMenu, removeFilterMenu, runFilter, runRemoveFilter } from './run';

/** Whether the song has any clip (a filter needs something to work on). */
const hasSong = (s: Services) => Object.keys(s.doc.getState().project.playlist.clips).length > 0;

/** The filtered-audio channels of the selected clips (what Remove filter acts on). */
const selectedFilters = (s: Services) => {
  const p = s.doc.getState().project;
  const ids = new Set(
    s.editor
      .getState()
      .clipSelection.map((id) => filterChannelOf(p, p.playlist.clips[id])?.id)
      .filter((x): x is ChannelId => !!x),
  );
  return [...ids];
};

/**
 * Sound filters (Nightcore, slowed + reverb, telephone, lo-fi…) on a part of the song: a
 * "Filter … ▸" submenu on clips, markers, the ruler and empty playlist spots, Playlist › Apply a
 * filter… (a chooser), "Filter: Nightcore" in the action search, and Remove filter on the result.
 * The work is in app/filters; the Studio has the matching `filter` action.
 */
export function register(services: Services): void {
  registerFilterCommands(services);
  registerChooser();
  registerFilterMenus();
  registerFilterSearch();
}

/** Choose a filter, apply one, and remove a filter. */
function registerFilterCommands({ commands }: Services): void {
  commands.register<{ filter?: string } | undefined>({
    id: 'filters.choose',
    title: 'Apply a filter…',
    category: 'Playlist',
    hint: 'Nightcore, slowed + reverb, telephone, lo-fi…: plays the selected clips, the loop region or the whole song through a sound filter (one undo step; Remove filter brings the original back)',
    ai: false,
    enabled: hasSong,
    run: (_s, args) => filterStore.setState({ open: args?.filter ? { filter: args.filter } : {} }),
  });
  commands.register<{ filter: string; target?: FilterTarget }>({
    id: 'filters.apply',
    title: 'Apply a sound filter',
    category: 'Playlist',
    hint: 'Renders a part of the song and plays it through a sound filter (the selected clips, else the loop region, else the whole song)',
    argsHint: '{ filter: "nightcore" | "telephone" | …, target? }',
    palette: false,
    ai: false,
    run: (s, args) => {
      const f = args && findFilter(args.filter);
      if (!f) {
        s.session.getState().toast(`Choose a filter: ${FILTERS.map((x) => x.name).join(', ')}.`, 'error');
        return;
      }
      return runFilter(s, f.id, args.target ?? currentTarget(s));
    },
  });
  commands.register({
    id: 'filters.remove',
    title: 'Remove filter',
    category: 'Playlist',
    hint: 'Deletes the selected filtered audio and puts back the clips it replaced, exactly as they were',
    ai: false,
    enabled: (s) => selectedFilters(s).length > 0,
    run: (s) => {
      for (const id of selectedFilters(s)) runRemoveFilter(s, id);
    },
  });
}

/** The Playlist menu entries and the chooser dialog. */
function registerChooser(): void {
  addMenuItems('playlist', [cmd('filters.choose', 33), cmd('filters.remove', 34)]);
  addOverlay('filters', FilterOverlay);
}

/** Right-click menus on clips, markers, the ruler and empty spots: each names the part it filters. */
function registerFilterMenus(): void {
  addContextMenuItems('playlist.clip', ({ clip }, s) => {
    const p = s.doc.getState().project;
    const sel = s.editor.getState().clipSelection;
    const target = clipsTarget(p, sel.includes(clip.id) ? sel : [clip.id]);
    return [...filterMenu(s, target), ...removeFilterMenu(s, clip.id)];
  });
  addContextMenuItems('playlist.marker', ({ markerId }, s) => filterMenu(s, markerTarget(s.doc.getState().project, markerId)));
  addContextMenuItems('playlist.ruler', ({ tick }, s) => {
    const p = s.doc.getState().project;
    const loop = s.view.getState().loop;
    if (loop && loop.end > loop.start) return filterMenu(s, rangeTarget(p, loop.start, loop.end));
    return hasSong(s) ? filterMenu(s, spotTarget(p, tick)) : [];
  });
  addContextMenuItems('playlist.empty', ({ tick }, s) => {
    if (!hasSong(s)) return [];
    const p = s.doc.getState().project;
    const loop = s.view.getState().loop;
    const inLoop = loop && loop.end > loop.start && tick >= loop.start && tick < loop.end;
    return filterMenu(s, inLoop ? rangeTarget(p, loop.start, loop.end) : spotTarget(p, tick));
  });
}

/** Action search: "Filter: Nightcore" on the usual target. */
function registerFilterSearch(): void {
  addActionProvider('filters', (s) => {
    const target = currentTarget(s);
    const where = target ? targetLabel(s.doc.getState().project, target) : 'the song';
    return FILTERS.map((f) => ({
        key: `filter:${f.id}`,
        label: `Filter: ${f.name}`,
        path: ['Playlist', 'Filters'],
        hint: filterHint(f, where),
        keywords: ['filter', 'effect', 'sound', ...(f.aliases ?? [])],
        disabled: !target,
        run: () => void runFilter(s, f.id, target),
      }));
  });
}
