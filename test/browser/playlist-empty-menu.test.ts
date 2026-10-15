/**
 * Clicking an empty spot of the playlist (headless Chrome, the real React shell, test services with the
 * fake engine): a click opens the empty-spot menu instead of placing a clip; Esc and an outside click
 * close it; its items place a pattern and ask Studio about the bar; a drag on empty space still places
 * the current pattern and the Select tool still rubber-bands.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import type { LaneId, PatternId } from '@core/model/types';
import { removeClips } from '@core/ops/playlist';
import { registerFeatures } from '@ui/features';
import { askStore, closeAsk } from '@ui/features/ask-ai/ask-state';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const BAR = 3840;
// pxPerTick 0.025: a bar is 96 px; lanes are 36 px tall.
const BAR_PX = 96;
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

// Real clicks in the whole app: generous per-test time for a busy machine.
describe('the playlist’s empty-spot menu (UI)', { timeout: 30_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let lanes: LaneId[];
  let pattern: PatternId;
  // The grid host (its hint follows the tool, so it is found once, with the Draw tool on).
  let gridEl: HTMLElement;
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const grid = () => gridEl;
  const clips = () => Object.values(s.doc.getState().project.playlist.clips);
  /** A spot in the grid: the middle of bar `bar` (1-based) on track `lane` (0-based). */
  const spot = (bar: number, lane: number) => ({ x: (bar - 1) * BAR_PX + BAR_PX / 2, y: lane * 36 + 18 });
  const item = (label: string) =>
    [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find((b) => b.textContent?.includes(label));
  /** Synthetic pointer events (mouse id 1) for a drag; the controller listens on the grid host. */
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const r = grid().getBoundingClientRect();
    const ev = (type: string, p: { x: number; y: number }, buttons: number) =>
      grid().dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: r.left + p.x, clientY: r.top + p.y }),
      );
    ev('pointerdown', from, 1);
    for (let i = 1; i <= 5; i++) ev('pointermove', { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 }, 1);
    ev('pointerup', to, 0);
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar', pxPerTick: 0.025, laneHeight: 36, scrollTick: 0, scrollLane: 0 });
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
    gridEl = host.querySelector<HTMLElement>('[data-window-type="playlist"] div[data-hint^="Draw:"]')!;
    await frames(3);
  });

  beforeEach(() => {
    closeContextMenu();
    closeAsk();
    const ids = clips().map((c) => c.id);
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids));
    s.editor.getState().setPlaylist({ tool: 'draw' });
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('the grid’s hint says a click opens the menu', () => {
    expect(grid().getAttribute('data-hint')).toMatch(/^Draw: click an empty spot for a menu/);
  });

  it('a click opens the menu instead of placing a clip; Esc closes it', async () => {
    const name = s.doc.getState().project.patterns[pattern]!.name;
    await userEvent.click(grid(), { position: spot(4, 0) });
    await until(() => !!menu());
    expect(clips()).toEqual([]);
    expect(menu()!.textContent).toContain(`bar 4`);
    expect(item(`Place “${name}” here`)).toBeTruthy();
    expect(item('Place a pattern…')).toBeTruthy();
    expect(item('Ask Studio about bar 4…')!.querySelector('svg')).not.toBeNull();
    expect(item('Add a marker here')).toBeTruthy();
    expect(item('Name this track…')).toBeTruthy();
    expect(menu()!.textContent).not.toMatch(/\bAI\b/);
    await userEvent.keyboard('{Escape}');
    await until(() => !menu());
    expect(clips()).toEqual([]);
  });

  it('an outside click closes it without placing anything', async () => {
    await userEvent.click(grid(), { position: spot(2, 1) });
    await until(() => !!menu());
    await userEvent.click(host.querySelector('header')!, { position: { x: 600, y: 20 } });
    await until(() => !menu());
    expect(clips()).toEqual([]);
  });

  it('“Place … here” places the current pattern at that bar and track (one undo step)', async () => {
    const name = s.doc.getState().project.patterns[pattern]!.name;
    await userEvent.click(grid(), { position: spot(4, 1) });
    await until(() => !!menu());
    await userEvent.click(item(`Place “${name}” here`)!);
    await until(() => !menu());
    expect(clips()).toMatchObject([{ kind: 'pattern', patternId: pattern, start: 3 * BAR, laneId: lanes[1] }]);
    expect(s.history.status().undoLabel).toBe(`Place ${name}`);
  });

  it('“Ask Studio about bar N…” opens the Ask card on that bar', async () => {
    await userEvent.click(grid(), { position: spot(6, 0) });
    await until(() => !!menu());
    await userEvent.click(item('Ask Studio about bar 6…')!);
    await until(() => askStore.getState().open);
    expect(askStore.getState().focus).toMatchObject({ from: 5 * BAR, to: 6 * BAR });
    expect(clips()).toEqual([]);
    closeAsk();
  });

  it('a drag on empty space still places the current pattern, where the drag ends; no menu', async () => {
    drag(spot(2, 0), spot(5, 1));
    await frames(2);
    expect(menu()).toBeNull();
    expect(clips()).toMatchObject([{ patternId: pattern, laneId: lanes[1] }]);
    expect(clips()[0]!.start).toBe(4 * BAR);
  });

  it('the Select tool still rubber-bands (no menu); a clip still drags', async () => {
    // A press that wanders a pixel is still a click: the menu, no clip.
    drag(spot(2, 0), { x: spot(2, 0).x + 1, y: spot(2, 0).y + 1 });
    await until(() => !!menu());
    expect(clips()).toEqual([]);
    closeContextMenu();
    await userEvent.click(grid(), { position: spot(5, 2) });
    await until(() => !!menu());
    await userEvent.click(item('Place “')!);
    await until(() => !menu());
    const [placed] = clips();
    s.editor.getState().selectClips([]);
    s.editor.getState().setPlaylist({ tool: 'select' });
    // Inside the view: a drag near its edges scrolls it.
    drag({ x: 3.5 * BAR_PX, y: 30 }, { x: 6.5 * BAR_PX, y: 3 * 36 - 10 });
    await frames(2);
    expect(menu()).toBeNull();
    expect(s.editor.getState().clipSelection).toEqual([placed!.id]);
    // Moving it a bar to the right with the draw tool.
    s.editor.getState().setPlaylist({ tool: 'draw' });
    drag(spot(5, 2), spot(6, 2));
    await frames(2);
    expect(menu()).toBeNull();
    expect(s.doc.getState().project.playlist.clips[placed!.id]?.start).toBe(5 * BAR);
  });
});
