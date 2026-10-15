import { beforeEach, describe, expect, it } from 'vitest';
import type { NoteId } from '@core/model/types';
import { registerFeatures } from '@ui/features';
import { BAR, clipsOf, project, stackedSong } from '../../../../test/helpers/focus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { getActionProviders } from '../../shell/actions';
import { askAboutMarker, askAboutSelection, askStore, closeAsk } from './ask-state';

function setup() {
  const { s, ids } = stackedSong();
  registerFeatures(s);
  const marker = (name: string) => Object.values(project(s).playlist.markers).find((m) => m.name === name)!.id;
  return { s, ids, marker };
}
const labels = (items: MenuEntry[]) => items.flatMap((i) => ('label' in i ? [i.label] : []));
const pick = (items: MenuEntry[], label: string) => {
  const e = items.find((i) => 'label' in i && i.label === label);
  if (!e || !('onSelect' in e)) throw new Error(`no menu entry “${label}” in ${labels(items).join(' | ')}`);
  return e as Extract<MenuEntry, { onSelect(): void }>;
};

describe('opening the Ask AI card', () => {
  beforeEach(() => closeAsk());

  it('asks about the selected clips, else the loop region, and says what to select when there is neither', () => {
    const { s, ids } = setup();
    expect(askAboutSelection(s)).toBe(false);
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/^Select some clips in the playlist, or drag on its ruler/);
    expect(askStore.getState().open).toBe(false);
    s.view.getState().setLoop({ start: 16 * BAR, end: 32 * BAR });
    expect(askAboutSelection(s)).toBe(true);
    expect(askStore.getState()).toMatchObject({ open: true, focus: { kind: 'section', from: 16 * BAR }, anchor: { kind: 'pill' } });
    const two = clipsOf(project(s), ids.patterns.Drop!).slice(0, 2).map((c) => c.id);
    s.editor.getState().selectClips(two);
    askAboutSelection(s);
    expect(askStore.getState().focus).toMatchObject({ kind: 'clips', clipIds: two });
  });

  it('a marker’s Studio mark loops its section and opens the card on the flag', () => {
    const { s, marker } = setup();
    const drop = marker('Drop');
    expect(askAboutMarker(s, drop)).toBe(true);
    expect(s.view.getState().loop).toEqual({ start: 36 * BAR, end: 52 * BAR });
    expect(s.view.getState().mode).toBe('song');
    expect(askStore.getState()).toMatchObject({ open: true, anchor: { kind: 'marker', markerId: drop } });
    // Only the replies that come after opening are the card's.
    expect(askStore.getState().since).toBe(s.assistant.store.getState().messages.at(-1)?.id ?? 0);
  });

  it('in the piano roll, asks about the selected notes', () => {
    const { s, ids } = setup();
    s.view.getState().showWindow('piano-roll', 'piano-roll');
    s.view.getState().setCurrentPattern(ids.patterns.Drop!);
    s.session.getState().selectChannel(ids.channels.Pluck!);
    const two = Object.keys(project(s).patterns[ids.patterns.Drop!]!.notes[ids.channels.Pluck!]!).slice(0, 2) as NoteId[];
    s.editor.getState().selectNotes(two);
    expect(askAboutSelection(s)).toBe(true);
    expect(askStore.getState().focus).toMatchObject({ kind: 'notes', noteIds: two, channelId: ids.channels.Pluck });
  });
});

describe('menus, shortcuts, commands and the action search', () => {
  beforeEach(() => closeAsk());

  it('adds “Ask AI about …” to the clip, marker, ruler and note menus', () => {
    const { s, ids, marker } = setup();
    const drops = clipsOf(project(s), ids.patterns.Drop!);
    // One clip, or the selection it belongs to.
    expect(labels(extraMenuItems('playlist.clip', { clip: drops[0]! }, s))).toContain('Ask AI about this clip…');
    s.editor.getState().selectClips([drops[0]!.id, drops[1]!.id]);
    pick(extraMenuItems('playlist.clip', { clip: drops[1]! }, s), 'Ask AI about the 2 selected clips…').onSelect();
    expect(askStore.getState().focus).toMatchObject({ kind: 'clips', clipIds: [drops[0]!.id, drops[1]!.id] });
    pick(extraMenuItems('playlist.marker', { markerId: marker('Verse') }, s), 'Ask AI about “Verse”…').onSelect();
    expect(askStore.getState().focus).toMatchObject({ kind: 'section', markerId: marker('Verse') });
    // The ruler offers it for the loop region (here the Verse, looped by the marker entry).
    pick(extraMenuItems('playlist.ruler', { tick: 0 }, s), 'Ask AI about bars 17–32…').onSelect();
    expect(askStore.getState().focus).toMatchObject({ kind: 'section', from: 16 * BAR, to: 32 * BAR });
    s.view.getState().setLoop(null);
    expect(labels(extraMenuItems('playlist.ruler', { tick: 0 }, s)).some((l) => l.startsWith('Ask AI'))).toBe(false);
    const noteIds = Object.keys(project(s).patterns[ids.patterns.Drop!]!.notes[ids.channels.Pluck!]!).slice(0, 3) as NoteId[];
    const ctx = { channelId: ids.channels.Pluck!, patternId: ids.patterns.Drop!, noteIds, tick: 0, key: 60 };
    pick(extraMenuItems('pianoRoll.note', ctx, s), 'Ask AI about these 3 notes…').onSelect();
    expect(askStore.getState().focus).toMatchObject({ kind: 'notes', noteIds });
  });

  it('binds Alt+A in the playlist and Alt+Shift+A in the piano roll (where Alt+A still arpeggiates)', () => {
    const { s } = setup();
    expect(s.keymap.match('Alt+A', { focus: 'playlist', inInput: false })?.command).toBe('ai.askSelection');
    expect(s.keymap.match('Alt+A', { focus: 'piano-roll', inInput: false })?.command).toBe('pianoRoll.arpeggiate');
    expect(s.keymap.match('Alt+Shift+A', { focus: 'piano-roll', inInput: false })?.command).toBe('ai.askSelection');
    // Typing in the card's box never triggers it.
    expect(s.keymap.match('Alt+A', { focus: 'playlist', inInput: true })).toBeUndefined();
    for (const id of ['ai.askSelection', 'ai.askSection', 'ai.clearFocus']) {
      expect(s.commands.get(id)?.ai).toBe(false);
      expect(s.commands.get(id)?.hint).toBeTruthy();
    }
  });

  it('asks about a section by name, and clears the AI studio’s part', () => {
    const { s, marker } = setup();
    expect(s.commands.isEnabled('ai.clearFocus')).toBe(false);
    s.commands.run('ai.askSection', 'Bridge');
    expect(askStore.getState().focus).toMatchObject({ kind: 'section', markerId: marker('Bridge') });
    s.commands.run('ai.askSection', 'Nope');
    expect(s.session.getState().toasts.at(-1)?.text).toBe('There is no marker “Nope”.');
    s.assistant.setFocus(askStore.getState().focus);
    expect(s.commands.isEnabled('ai.clearFocus')).toBe(true);
    s.commands.run('ai.clearFocus');
    expect(s.assistant.store.getState().focus).toBeNull();
    expect(askStore.getState().open).toBe(false);
  });

  it('lists “Ask AI about: <section>” in the action search', () => {
    const { s, marker } = setup();
    const entries = getActionProviders().flatMap((p) => p(s));
    const verse = entries.find((e) => e.label === 'Ask AI about: Verse');
    expect(verse?.path).toEqual(['Playlist', 'Ask AI about a section']);
    verse!.run();
    expect(askStore.getState().focus).toMatchObject({ kind: 'section', markerId: marker('Verse') });
  });
});
