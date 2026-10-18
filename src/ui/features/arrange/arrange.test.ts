import { describe, expect, it, vi } from 'vitest';
import { createTestServices } from '@app/testing';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { registerFeatures } from '@ui/features';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { getMenuItems } from '../../shell/menus';
import { developRange } from './register';

const BAR = 3840;

function setup() {
  const s = createTestServices();
  registerFeatures(s);
  let ids!: ReturnType<typeof buildStackedSong>;
  s.history.transact('song', (d) => {
    ids = buildStackedSong(d);
  });
  return { s, ids };
}

/** The entries with an action, once each (every test registers the features again: providers pile up). */
const items = (list: MenuEntry[]) => {
  const seen = new Set<string>();
  return list.filter((e): e is Extract<MenuEntry, { label: string; onSelect(): void }> => {
    if (!('onSelect' in e) || !('label' in e) || seen.has(e.label)) return false;
    seen.add(e.label);
    return true;
  });
};
const toasts = (s: ReturnType<typeof createTestServices>) => s.session.getState().toasts.map((t) => t.text);

describe('arranging from the playlist (no AI)', () => {
  it('puts its commands in the Playlist menu with plain hints', () => {
    const { s } = setup();
    const ids = getMenuItems('playlist').flatMap((i) => (i.kind === 'command' ? [i.command] : []));
    expect(ids).toEqual(expect.arrayContaining(['arrange.develop', 'arrange.addFill', 'arrange.addTransition', 'arrange.refresh']));
    for (const id of ['arrange.develop', 'arrange.addFill', 'arrange.addTransition', 'arrange.refresh']) {
      const def = s.commands.get(id)!;
      expect(def.hint!.length).toBeGreaterThan(40);
      expect(def.ai).toBe(false);
    }
    expect(s.commands.isEnabled('arrange.refresh')).toBe(false);
  });

  // The arranger's code loads on first use, so a command says what it did a moment after it runs.
  const toast = (s: ReturnType<typeof createTestServices>) => vi.waitFor(() => expect(toasts(s).length).toBeGreaterThan(0));

  it('develops the loop region from the menu, one undo step, and says what it did', async () => {
    const { s } = setup();
    s.view.getState().setLoop({ start: 32 * BAR, end: 52 * BAR });
    expect(developRange(s)).toEqual({ from: 32 * BAR, to: 52 * BAR });
    s.commands.run('arrange.develop');
    await toast(s);
    expect(toasts(s).at(-1)).toMatch(/^Developed bars 33–52: /);
    expect(s.history.steps().done.map((e) => e.label)).toEqual(['song', 'Develop bars 33–52']);
    expect(s.commands.isEnabled('arrange.refresh')).toBe(true);
  });

  // Other features (Ask Studio, Export as MP3 or video, the clip launcher) add their own entries to these menus; check this one's.
  const mine = (entries: Parameters<typeof items>[0]) =>
    items(entries).filter((e) => !e.label.startsWith('Ask Studio') && !/^Export .* as (MP3|video…)$/.test(e.label) && e.label !== 'Send to clip launcher');

  it('marker and ruler right-click entries develop a section and add fills and transitions', async () => {
    const { s } = setup();
    const p = s.doc.getState().project;
    const drop = Object.values(p.playlist.markers).find((m) => m.name === 'Drop')!;
    const marker = mine(extraMenuItems('playlist.marker', { markerId: drop.id }, s));
    expect(marker.map((e) => e.label)).toEqual(['Develop “Drop” (fills, transitions)', 'Add a transition into “Drop”']);
    marker[0]!.onSelect();
    await toast(s);
    expect(toasts(s).at(-1)).toMatch(/^Developed bars 37–52/);
    const ruler = mine(extraMenuItems('playlist.ruler', { tick: 20 * BAR + 100 }, s));
    expect(ruler.map((e) => e.label)).toEqual(['Add a fill here (end of bar 21)', 'Add a transition here (into bar 21)', 'Develop the whole song (fills, transitions)']);
    ruler[0]!.onSelect();
    await vi.waitFor(() => expect(toasts(s).at(-1)).toMatch(/fill at the end of bar 21/));
    const clip = Object.values(s.doc.getState().project.playlist.clips).find((c) => c.kind === 'pattern' && c.start === 18 * BAR)!;
    const onClip = mine(extraMenuItems('playlist.clip', { clip }, s));
    expect(onClip.map((e) => e.label)).toEqual(['Add a fill at the end of this clip', 'Add a transition after this clip']);
  });
});
