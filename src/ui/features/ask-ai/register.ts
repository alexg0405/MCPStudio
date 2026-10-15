import type { Services } from '@app/services';
import { describeMarker, findMarker, songPosition } from '@app/actions/markers';
import { markersSorted } from '@core/ops/markers';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep, type DynamicMenuEntry } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { trackPointer } from './anchors';
import { AskCardOverlay } from './AskCard';
import { askAboutMarker, askAboutSelection, closeAsk } from './ask-state';
import { registerAskMenus } from './menus';

/** Before the arranger (order 100), so "Ask Studio about …" leads the extra items of the menus both add to. */
export const order = 99;

/**
 * "Ask AI about this part": select clips, loop some bars, pick a marker's section or some notes, and
 * tell the AI what to change there; only that part changes, as one undo step. Entry points: the
 * playlist's Ask AI pill and the Studio mark on marker flags (wired in the playlist), right-click menus, Alt+A,
 * the Playlist and Edit menus and the action search ("Ask AI about: Verse").
 */
export function register(services: Services): void {
  const { commands, keymap } = services;
  addOverlay('ask-ai', AskCardOverlay);
  registerAskMenus();
  trackPointer();

  commands.register({
    id: 'ai.askSelection',
    title: 'Ask Studio about the selection…',
    category: 'Studio',
    hint: 'Tell Studio what to change in the selected clips, the loop region or the selected notes: only that part changes (one undo step)',
    ai: false,
    run: (s) => void askAboutSelection(s),
  });
  // Alt+A in the playlist; the piano roll's Alt+A arpeggiates (as in FL), so there it is Alt+Shift+A.
  keymap.add([
    { chord: 'Alt+A', command: 'ai.askSelection', when: { focus: ['playlist'] } },
    { chord: 'Alt+Shift+A', command: 'ai.askSelection', when: { focus: ['piano-roll'] } },
  ]);

  const hasMarkers = (s: Services) => Object.keys(s.doc.getState().project.playlist.markers).length > 0;
  commands.register<string | number | { marker?: string | number } | undefined>({
    id: 'ai.askSection',
    title: 'Ask Studio about a section…',
    category: 'Studio',
    hint: 'Loop a marker’s section and tell Studio what to change in it: only that section changes',
    argsHint: 'the marker: its name, id or number (without: the section at the song position)',
    ai: false,
    enabled: hasMarkers,
    run: (s, args) => {
      const ref = typeof args === 'object' && args !== null ? args.marker : args;
      const sections = songSections(s.doc.getState().project);
      const at = songPosition(s);
      const id =
        ref !== undefined && ref !== null && ref !== ''
          ? findMarker(s, ref)?.id
          : (sections.find((x) => x.from <= at && at < x.to) ?? sections[0])?.markerId;
      if (!id) {
        s.session
          .getState()
          .toast(
            sections.length
              ? `There is no marker “${String(ref)}”.`
              : 'Add a marker first (right-click the playlist ruler, or Alt+T): its section is what you ask about.',
            sections.length ? 'error' : 'info',
          );
        return;
      }
      askAboutMarker(s, id);
    },
  });

  commands.register({
    id: 'ai.clearFocus',
    title: 'Ask Studio about the whole song again',
    category: 'Studio',
    hint: 'Stop working on a part: the next request in Studio is about the whole song',
    ai: false,
    enabled: (s) => !!s.assistant.store.getState().focus,
    run: (s) => {
      if (!s.assistant.store.getState().focus) return;
      s.assistant.setFocus(null);
      closeAsk();
      s.session.getState().toast('Studio is about the whole song again.');
    },
  });

  // One entry per marker in the Playlist menu and the action search.
  const sectionEntries = (): DynamicMenuEntry[] => {
    const p = services.doc.getState().project;
    const list = songSections(p);
    if (list.length === 0)
      return [{ label: 'No markers yet: right-click the ruler or press Alt+T', disabled: true, run: () => {} }];
    return list.map((x) => ({
      label: `${x.name} (${barSpan(x.from, x.to, p.transport.timeSig)})`,
      hint: `Loop “${x.name}” and tell Studio what to change in it`,
      run: () => void askAboutMarker(services, x.markerId),
    }));
  };
  addMenuItems('playlist', [
    cmd('ai.askSelection', 20, 'Ask Studio about the selection…'),
    {
      kind: 'submenu',
      id: 'ask-ai-sections',
      label: 'Ask Studio about a section',
      order: 21,
      items: () => [{ kind: 'dynamic', id: 'ask-ai-section-list', order: 0, entries: sectionEntries }],
    },
    cmd('ai.clearFocus', 22),
    sep(29),
  ]);
  addMenuItems('edit', [sep(27), cmd('ai.askSelection', 28, 'Ask Studio about the selection…')]);
  addActionProvider('ask-ai-sections', (s) =>
    markersSorted(s.doc.getState().project).map((m) => ({
      key: `ask-ai:${m.id}`,
      label: `Ask Studio about: ${m.name}`,
      path: ['Playlist', 'Ask Studio about a section'],
      hint: `Loop ${describeMarker(s, m)} to the next marker and tell Studio what to change there`,
      keywords: ['ai', 'section', 'part', 'change', 'fix', 'marker'],
      run: () => void askAboutMarker(s, m.id),
    })),
  );
}
