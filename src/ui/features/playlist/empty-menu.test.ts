import { beforeEach, describe, expect, it } from 'vitest';
import type { LaneId, PatternClip } from '@core/model/types';
import { registerFeatures } from '@ui/features';
import { BAR, project, stackedSong } from '../../../../test/helpers/focus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { askStore, closeAsk } from '../ask-ai/ask-state';
import { playlistCommands } from './commands';
import { emptyMenu } from './empty-menu';
import { markerRename } from './markers';

type Item = Extract<MenuEntry, { onSelect(): void; label: string }>;

/** Labels in order, each once (every test registers the features again, so providers pile up). */
const labels = (items: MenuEntry[]) => [...new Set(items.flatMap((i) => ('label' in i ? [i.label] : [])))];
const pick = (items: MenuEntry[], label: string): Item => {
  const e = items.find((i) => 'label' in i && i.label === label);
  if (!e || !('onSelect' in e)) throw new Error(`no menu entry “${label}” in ${labels(items).join(' | ')}`);
  return e as Item;
};
const submenu = (items: MenuEntry[], label: string): MenuEntry[] => {
  const e = items.find((i) => i.kind === 'submenu' && i.label === label);
  if (!e || e.kind !== 'submenu') throw new Error(`no submenu “${label}”`);
  return typeof e.items === 'function' ? e.items() : e.items;
};

// Past the end of the 113-bar song: an empty spot.
const TICK = 120 * BAR;

function setup() {
  const { s } = stackedSong();
  registerFeatures(s);
  const lanes = project(s).playlist.laneOrder as LaneId[];
  const at = (tick: number, lane: LaneId) =>
    Object.values(project(s).playlist.clips).filter((c) => c.start === tick && c.laneId === lane) as PatternClip[];
  return { s, lanes, at };
}

describe('the empty-spot menu (a click on an empty playlist cell)', () => {
  beforeEach(() => closeAsk());

  it('offers placing a pattern, Studio, a fill or transition, a marker and naming the track', () => {
    const { s, lanes } = setup();
    const p = project(s);
    const current = p.patterns[s.view.getState().currentPatternId!]!;
    const lane = p.playlist.lanes[lanes[1]!]!;
    const menu = emptyMenu(s, TICK, lanes[1]!, () => {});
    expect(labels(menu)).toEqual([
      `${lane.name} · bar 121`,
      `Place “${current.name}” here`,
      'Place a pattern…',
      'Play from bar 121',
      'Ask Studio about bar 121…',
      'Add a fill here (end of bar 121)',
      'Add a transition here (into bar 121)',
      'Add a marker here (121:01:000)',
      'Name this track…',
    ]);
    // Ask Studio carries the Studio mark; nothing says "AI".
    expect(pick(menu, 'Ask Studio about bar 121…').icon).toBe('studio');
    expect(labels(menu).some((l) => /\bAI\b/.test(l))).toBe(false);
    // The submenu lists the patterns in order, the current one checked, then New pattern.
    const pats = submenu(menu, 'Place a pattern…');
    expect(labels(pats)).toEqual([...p.patternOrder.map((id) => p.patterns[id]!.name), 'New pattern']);
    expect(pick(pats, current.name).checked).toBe(true);
  });

  it('places the current pattern (one undo step) and selects it', () => {
    const { s, lanes, at } = setup();
    const current = s.view.getState().currentPatternId!;
    const name = project(s).patterns[current]!.name;
    pick(emptyMenu(s, TICK, lanes[2]!, () => {}), `Place “${name}” here`).onSelect();
    const [clip] = at(TICK, lanes[2]!);
    expect(clip).toMatchObject({ kind: 'pattern', patternId: current, offset: 0 });
    expect(s.editor.getState().clipSelection).toEqual([clip!.id]);
    expect(s.history.status().undoLabel).toBe(`Place ${name}`);
    s.history.undo();
    expect(at(TICK, lanes[2]!)).toEqual([]);
  });

  it('places another pattern from the submenu (it becomes current), or a new one', () => {
    const { s, lanes, at } = setup();
    const p = project(s);
    const other = p.patternOrder.find((id) => id !== s.view.getState().currentPatternId)!;
    pick(submenu(emptyMenu(s, TICK, lanes[0]!, () => {}), 'Place a pattern…'), p.patterns[other]!.name).onSelect();
    expect(at(TICK, lanes[0]!).map((c) => c.patternId)).toEqual([other]);
    expect(s.view.getState().currentPatternId).toBe(other);
    const before = project(s).patternOrder.length;
    pick(submenu(emptyMenu(s, TICK + BAR * 4, lanes[0]!, () => {}), 'Place a pattern…'), 'New pattern').onSelect();
    expect(project(s).patternOrder.length).toBe(before + 1);
    const made = s.view.getState().currentPatternId!;
    expect(at(TICK + BAR * 4, lanes[0]!).map((c) => c.patternId)).toEqual([made]);
  });

  it('says why placing is off when there is no current pattern', () => {
    const { s, lanes } = setup();
    s.view.getState().setCurrentPattern(null);
    const place = pick(emptyMenu(s, TICK, lanes[0]!, () => {}), 'Place the current pattern here');
    expect(place.disabled).toBe(true);
    expect(place.hint).toMatch(/New pattern/);
  });

  it('pastes copied clips at the spot, keeping their spacing across tracks', () => {
    const { s, lanes, at } = setup();
    expect(labels(emptyMenu(s, TICK, lanes[0]!, () => {})).some((l) => l.startsWith('Paste'))).toBe(false);
    const p = project(s);
    const a = Object.values(p.playlist.clips).find((c) => c.laneId === lanes[0] && c.start === 0)!;
    const b = Object.values(p.playlist.clips).find((c) => c.laneId === lanes[1] && c.start >= a.start)!;
    s.editor.getState().selectClips([a.id, b.id]);
    playlistCommands.copy(s);
    pick(emptyMenu(s, TICK, lanes[2]!, () => {}), 'Paste 2 clips here').onSelect();
    expect(at(TICK, lanes[2]!)).toHaveLength(1);
    expect(at(TICK + b.start - a.start, lanes[3]!).length).toBeGreaterThanOrEqual(1);
    expect(s.editor.getState().clipSelection).toHaveLength(2);
    expect(s.history.status().undoLabel).toBe('Paste clips');
  });

  it('asks Studio about the bar, adds a marker, and names the track', () => {
    const { s, lanes } = setup();
    pick(emptyMenu(s, TICK + 100, lanes[0]!, () => {}), 'Ask Studio about bar 121…').onSelect();
    expect(askStore.getState()).toMatchObject({ open: true, focus: { from: TICK, to: TICK + BAR } });
    pick(emptyMenu(s, TICK, lanes[0]!, () => {}), 'Add a marker here (121:01:000)').onSelect();
    const id = markerRename.getState().id!;
    expect(project(s).playlist.markers[id]?.tick).toBe(TICK);
    let renamed = 0;
    pick(emptyMenu(s, TICK, lanes[0]!, () => void renamed++), 'Name this track…').onSelect();
    expect(renamed).toBe(1);
  });

  it('is empty for a track that is gone', () => {
    const { s } = setup();
    expect(emptyMenu(s, TICK, 'lane_gone' as LaneId, () => {})).toEqual([]);
  });
});
