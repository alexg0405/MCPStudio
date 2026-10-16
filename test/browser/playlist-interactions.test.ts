/**
 * Playlist interactions (headless Chrome, the real React shell, test services with the fake engine):
 * placing, moving, resizing, slicing, copying, duplicating and deleting clips are each one undo step,
 * Esc and a cancelled pointer leave the clips alone, and the selection and tool behave as they should.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { newId } from '@core/model/ids';
import type { Clip, ClipId, LaneId, PatternId } from '@core/model/types';
import { addClips, removeClips } from '@core/ops/playlist';
import { clipsSorted } from '@core/query/playlist';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const BAR = 3840;
const BAR_PX = 96; // pxPerTick 0.025
const LANE_H = 36;
const until = async (ok: () => boolean, ms = 5000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 16));
  }
};
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe('playlist interactions (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let lanes: LaneId[];
  let pattern: PatternId;
  let grid: HTMLElement;
  const clips = (): Clip[] => clipsSorted(s.doc.getState().project.playlist.clips) as Clip[];
  const cursor = () => s.history.status().cursor;
  /** A spot in the grid: `fraction` of the way through bar `bar` (1-based) on track `lane` (0-based). */
  const spot = (bar: number, lane: number, fraction = 0.5) => ({ x: (bar - 1 + fraction) * BAR_PX, y: lane * LANE_H + LANE_H / 2 });
  const fire = (type: string, p: { x: number; y: number }, init: PointerEventInit = {}) => {
    const r = grid.getBoundingClientRect();
    grid.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: r.left + p.x,
        clientY: r.top + p.y,
        ...init,
      }),
    );
  };
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }, init: PointerEventInit = {}) => {
    fire('pointerdown', from, init);
    for (let i = 1; i <= 5; i++) fire('pointermove', { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 }, init);
    fire('pointerup', to, init);
  };
  const seed = (list: { bar: number; lane: number; bars: number }[]): Clip[] => {
    const made = list.map(
      (c): Clip => ({ kind: 'pattern', id: newId.clip(), laneId: lanes[c.lane] as LaneId, start: (c.bar - 1) * BAR, length: c.bars * BAR, patternId: pattern, offset: 0 }),
    );
    s.history.transact('seed', (d) => addClips(d, made));
    return made;
  };
  const setTool = (tool: 'draw' | 'select' | 'delete' | 'slice' | 'paint') => s.editor.getState().setPlaylist({ tool });

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar', pxPerTick: 0.025, laneHeight: LANE_H, scrollTick: 0, scrollLane: 0 });
    const p = s.doc.getState().project;
    lanes = p.playlist.laneOrder as LaneId[];
    pattern = p.patternOrder[0] as PatternId;
    s.view.getState().setCurrentPattern(pattern);
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="playlist"] div[data-hint^="Draw:"]'));
    grid = host.querySelector<HTMLElement>('[data-window-type="playlist"] div[data-hint^="Draw:"]')!;
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    const ids = clips().map((c) => c.id);
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids as ClipId[]));
    s.editor.getState().selectClips([]);
    s.editor.getState().setClipClipboard(null);
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar' });
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('dragging on an empty spot places the current pattern as one undo step, and selects it', async () => {
    const before = cursor();
    drag(spot(2, 0), spot(4, 1));
    expect(clips()).toHaveLength(1);
    expect(clips()[0]).toMatchObject({ kind: 'pattern', patternId: pattern, laneId: lanes[1], start: 3 * BAR });
    expect(s.editor.getState().clipSelection).toEqual([clips()[0]!.id]);
    await s.history.undo();
    expect(clips()).toHaveLength(0);
    expect(cursor()).toBe(before);
  });

  it('dragging a clip moves it (bar-snapped, across tracks) in one undo step; undo keeps it selected', async () => {
    const [c] = seed([{ bar: 2, lane: 0, bars: 2 }]);
    const before = cursor();
    drag(spot(2, 0, 0.5), spot(5, 2, 0.5));
    expect(clips()[0]).toMatchObject({ start: 4 * BAR, laneId: lanes[2], length: 2 * BAR });
    expect(s.history.status().undoLabel).toMatch(/move/i);
    await s.history.undo();
    expect(cursor()).toBe(before);
    expect(clips()[0]).toMatchObject({ start: BAR, laneId: lanes[0] });
    expect(s.editor.getState().clipSelection).toEqual([c!.id]);
  });

  it('dragging a selection of clips moves them together in one step', async () => {
    const made = seed([
      { bar: 1, lane: 0, bars: 1 },
      { bar: 3, lane: 1, bars: 1 },
      { bar: 5, lane: 2, bars: 1 },
    ]);
    s.editor.getState().selectClips(made.map((c) => c.id));
    const before = cursor();
    drag(spot(3, 1), spot(4, 1));
    expect(clips().map((c) => c.start / BAR)).toEqual([1, 3, 5]);
    await s.history.undo();
    expect(clips().map((c) => c.start / BAR)).toEqual([0, 2, 4]);
    expect(cursor()).toBe(before);
  });

  it('dragging the right edge resizes a clip (one step); the left edge trims it', async () => {
    seed([{ bar: 2, lane: 0, bars: 2 }]);
    const endX = 3 * BAR_PX; // the clip ends where bar 3 ends
    const before = cursor();
    drag({ x: endX - 2, y: spot(1, 0).y }, { x: endX - 2 + BAR_PX, y: spot(1, 0).y });
    expect(clips()[0]).toMatchObject({ start: BAR, length: 3 * BAR });
    await s.history.undo();
    expect(cursor()).toBe(before);
    expect(clips()[0]).toMatchObject({ length: 2 * BAR });
    // Left edge: trims the start, the content stays in place.
    drag({ x: BAR_PX + 2, y: spot(1, 0).y }, { x: 2 * BAR_PX + 2, y: spot(1, 0).y });
    expect(clips()[0]).toMatchObject({ start: 2 * BAR, length: BAR, offset: BAR });
    await s.history.undo();
    expect(cursor()).toBe(before);
  });

  it('Esc during a move drops it: nothing changes, no undo step', async () => {
    seed([{ bar: 2, lane: 0, bars: 1 }]);
    const before = cursor();
    fire('pointerdown', spot(2, 0));
    fire('pointermove', spot(5, 1));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fire('pointerup', spot(5, 1));
    expect(clips()[0]).toMatchObject({ start: BAR, laneId: lanes[0] });
    expect(cursor()).toBe(before);
  });

  it('a cancelled pointer ends a move without committing, and later moves do nothing', async () => {
    seed([{ bar: 2, lane: 0, bars: 1 }]);
    const before = cursor();
    fire('pointerdown', spot(2, 0));
    fire('pointermove', spot(5, 1));
    fire('pointercancel', spot(5, 1));
    fire('pointermove', spot(8, 2), { buttons: 0 });
    expect(clips()[0]).toMatchObject({ start: BAR, laneId: lanes[0] });
    expect(cursor()).toBe(before);
  });

  it('the Slice tool cuts a clip in two at the grid line (one step)', async () => {
    seed([{ bar: 2, lane: 0, bars: 4 }]);
    setTool('slice');
    const before = cursor();
    fire('pointerdown', spot(4, 0, 0.1));
    fire('pointerup', spot(4, 0, 0.1));
    expect(clips()).toHaveLength(2);
    expect(clips().map((c) => c.length / BAR)).toEqual([2, 2]);
    await s.history.undo();
    expect(clips()).toHaveLength(1);
    expect(cursor()).toBe(before);
  });

  it('the Delete tool removes a clicked clip, or a dragged-over run, in one step', async () => {
    seed([
      { bar: 1, lane: 0, bars: 1 },
      { bar: 3, lane: 0, bars: 1 },
      { bar: 5, lane: 0, bars: 1 },
    ]);
    setTool('delete');
    const before = cursor();
    drag(spot(1, 0), spot(5, 0));
    expect(clips()).toHaveLength(0);
    await s.history.undo();
    expect(clips()).toHaveLength(3);
    expect(cursor()).toBe(before);
  });

  it('right-click with the draw tool deletes the clip under it (one step)', async () => {
    seed([{ bar: 3, lane: 1, bars: 2 }]);
    const before = cursor();
    fire('pointerdown', spot(3, 1), { button: 2, buttons: 2 });
    fire('pointerup', spot(3, 1), { button: 2, buttons: 0 });
    expect(clips()).toHaveLength(0);
    await s.history.undo();
    expect(clips()).toHaveLength(1);
    expect(cursor()).toBe(before);
  });

  it('copy and paste, duplicate and delete are each one undo step, and the pasted clips are selected', async () => {
    const made = seed([
      { bar: 1, lane: 0, bars: 2 },
      { bar: 2, lane: 1, bars: 1 },
    ]);
    s.editor.getState().selectClips(made.map((c) => c.id));
    const seeded = cursor();
    s.commands.run('playlist.copy');
    expect(cursor()).toBe(seeded);
    s.commands.run('playlist.paste');
    expect(clips()).toHaveLength(4);
    expect(s.editor.getState().clipSelection).toHaveLength(2);
    expect(s.editor.getState().clipSelection.every((id) => !made.some((m) => m.id === id))).toBe(true);
    await s.history.undo();
    expect(cursor()).toBe(seeded);
    expect(clips()).toHaveLength(2);
    s.editor.getState().selectClips(made.map((c) => c.id));
    s.commands.run('playlist.duplicate');
    expect(clips()).toHaveLength(4);
    await s.history.undo();
    expect(cursor()).toBe(seeded);
    s.editor.getState().selectClips(made.map((c) => c.id));
    s.commands.run('playlist.delete');
    expect(clips()).toHaveLength(0);
    await s.history.undo();
    expect(clips()).toHaveLength(2);
    expect(cursor()).toBe(seeded);
  });

  it('a click that wanders a pixel still opens the empty-spot menu, and the Select tool box-selects', async () => {
    const made = seed([
      { bar: 2, lane: 0, bars: 1 },
      { bar: 4, lane: 1, bars: 1 },
      { bar: 9, lane: 2, bars: 1 },
    ]);
    setTool('select');
    const before = cursor();
    drag({ x: 0.5 * BAR_PX, y: 2 }, { x: 6 * BAR_PX, y: 2 * LANE_H - 2 });
    expect(new Set(s.editor.getState().clipSelection)).toEqual(new Set([made[0]!.id, made[1]!.id]));
    expect(cursor()).toBe(before);
  });
});
