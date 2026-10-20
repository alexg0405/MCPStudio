/**
 * Clicking an empty spot of the playlist (headless Chrome, the real React shell, test services with the
 * fake engine): a click opens the empty-spot menu instead of placing a clip; its ×, Esc and an outside
 * click close it (and the outside click does nothing else); it stays on screen at the edges and its
 * submenu opens beside its row; its items place a pattern and ask Studio about the bar; a drag on empty
 * space still places the current pattern and the Select tool still rubber-bands. Then Follow playhead:
 * the view scrolls along while playing and holds still after a hand scroll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import type { LaneId, PatternId } from '@core/model/types';
import { newId } from '@core/model/ids';
import { addClips, removeClips } from '@core/ops/playlist';
import { registerFeatures } from '@ui/features';
import { askStore, closeAsk } from '@ui/features/ask-ai/ask-state';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { closeContextMenu, showContextMenu } from '@ui/controls/ContextMenu';
import { HEADER_WIDTH } from '@ui/features/playlist/layout';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY } from '../helpers/wait';

const BAR = 3840;
// pxPerTick 0.025: a bar is 96 px; lanes are 36 px tall.
const BAR_PX = 96;
const until = async (ok: () => boolean, ms = 30_000) => {
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
describe('the playlist’s empty-spot menu (UI)', { timeout: 90_000 }, () => {
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

  it('its header has a × that closes it', async () => {
    await userEvent.click(grid(), { position: spot(3, 2) });
    await until(() => !!menu());
    const close = menu()!.querySelector<HTMLElement>('button[aria-label="Close (Esc)"]')!;
    expect(close.getAttribute('data-hint')).toBe('Close (Esc)');
    // Top right, on the header's row ("Track 3 · bar 3").
    const m = menu()!.getBoundingClientRect();
    const r = close.getBoundingClientRect();
    expect(m.right - r.right).toBeLessThan(10);
    expect(r.top - m.top).toBeLessThan(12);
    expect(close.parentElement!.textContent).toContain('bar 3');
    await userEvent.click(close);
    await until(() => !menu());
    expect(clips()).toEqual([]);
  });

  it('a click elsewhere on the grid only closes it: no new menu, no clip', async () => {
    await userEvent.click(grid(), { position: spot(2, 0) });
    await until(() => !!menu());
    await userEvent.click(grid(), { position: spot(7, 3) });
    await frames(3);
    expect(menu()).toBeNull();
    expect(clips()).toEqual([]);
    // A right-click elsewhere (with the draw tool it deletes) also only closes it.
    await userEvent.click(grid(), { position: spot(2, 0) });
    await until(() => !!menu());
    await userEvent.click(grid(), { position: spot(7, 3), button: 'right' });
    await frames(3);
    expect(menu()).toBeNull();
    // The next click opens it again.
    await userEvent.click(grid(), { position: spot(7, 3) });
    await until(() => !!menu());
    expect(menu()!.textContent).toContain('bar 7');
  });

  it('the keyboard moves through it: ↓ to the first item, Enter picks it', async () => {
    await userEvent.click(grid(), { position: spot(5, 0) });
    await until(() => !!menu());
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Place “');
    await userEvent.keyboard('{Enter}');
    await until(() => !menu());
    expect(clips()).toMatchObject([{ start: 4 * BAR, laneId: lanes[0] }]);
  });

  it('near the bottom-right corner it opens above and left of the pointer, inside the window', async () => {
    const r = grid().getBoundingClientRect();
    const at = { x: r.width - 30, y: r.height - 20 };
    await userEvent.click(grid(), { position: at });
    await until(() => !!menu() && menu()!.style.visibility !== 'hidden');
    const m = menu()!.getBoundingClientRect();
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.top).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(window.innerWidth);
    expect(m.bottom).toBeLessThanOrEqual(window.innerHeight);
    // Flipped: it doesn't open under the pointer.
    expect(m.right).toBeLessThanOrEqual(r.left + at.x + 1);
    expect(m.bottom).toBeLessThanOrEqual(r.top + at.y + 1);
    // Its submenu opens beside its row (flipped to the left here), on screen.
    await userEvent.hover(item('Place a pattern…')!);
    await until(() => document.querySelectorAll('[role="menu"]').length === 2);
    const sub = document.querySelectorAll<HTMLElement>('[role="menu"]')[1]!;
    await until(() => sub.style.visibility !== 'hidden');
    const row = item('Place a pattern…')!.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    expect(Math.abs(sr.top - (row.top - 5))).toBeLessThan(2);
    expect(sr.right).toBeLessThanOrEqual(row.left + 1);
    expect(sr.left).toBeGreaterThanOrEqual(0);
  });

  it('a submenu opens right beside its row and stays open on the way to it', async () => {
    showContextMenu({ x: 300, y: 200 }, [
      { kind: 'label', label: 'Header' },
      { kind: 'submenu', label: 'More', items: [{ label: 'Inner', onSelect: () => {} }] },
      { label: 'Below', onSelect: () => {} },
    ]);
    await until(() => !!menu() && menu()!.style.visibility !== 'hidden');
    const more = item('More')!;
    await userEvent.hover(more);
    await until(() => document.querySelectorAll('[role="menu"]').length === 2);
    const sub = document.querySelectorAll<HTMLElement>('[role="menu"]')[1]!;
    await until(() => sub.style.visibility !== 'hidden');
    const row = more.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    expect(Math.abs(sr.left - row.right)).toBeLessThan(2);
    expect(Math.abs(sr.top - (row.top - 5))).toBeLessThan(2);
    // Crossing the row below on the way there doesn't snap it shut (pointer moves, back to back).
    const inner = sub.querySelector<HTMLElement>('[role="menuitem"]')!;
    const below = item('Below')!;
    const move = (from: Element, to: Element) => {
      from.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: to, pointerId: 1, pointerType: 'mouse' }));
      to.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: from, pointerId: 1, pointerType: 'mouse' }));
    };
    move(more, below);
    move(below, inner);
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelectorAll('[role="menu"]').length).toBe(2);
    // Resting on another row closes it after a moment.
    move(inner, below);
    await until(() => document.querySelectorAll('[role="menu"]').length === 1);
    await userEvent.keyboard('{Escape}');
    await until(() => !menu());
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

  describe('follow playhead', () => {
    const playheadEl = () => host.querySelector<HTMLElement>('[data-window-type="playlist"] [class*="playhead"]')!;
    /** The playhead's x in the grid (NaN while it is off-screen). */
    const playheadX = () => {
      const el = playheadEl();
      if (el.style.display === 'none') return NaN;
      return Number(/translateX\(([-\d.]+)px\)/.exec(el.style.transform)?.[1]) - HEADER_WIDTH;
    };
    const width = () => grid().getBoundingClientRect().width;
    /** Ticks across the view (pxPerTick 0.025). */
    const visible = () => width() / 0.025;
    /** The playhead sits about 15% in from the left. */
    const nearLeft = () => Math.abs(playheadX() / width() - 0.15) < 0.01;
    const play = (tick: number) => {
      s.fakeEngine.startTick = tick;
      s.engine.play();
    };
    const wheel = (deltaY: number) =>
      grid().dispatchEvent(new WheelEvent('wheel', { deltaY, shiftKey: true, bubbles: true, cancelable: true }));
    const scrollHome = async () => {
      wheel(-1e7);
      await frames(2);
    };

    beforeEach(() => {
      closeContextMenu();
      s.engine.stop();
      s.view.getState().setMode('song');
      s.prefs.getState().set({ followPlayhead: true, followStyle: 'page' });
      // A long song, so the view can scroll a long way.
      s.history.transact('long song', (d) =>
        addClips(d, [{ kind: 'pattern', id: newId.clip(), laneId: lanes[3]!, start: 200 * BAR, length: BAR, patternId: pattern, offset: 0 }]),
      );
    });

    afterAll(async () => {
      s.engine.stop();
      s.fakeEngine.startTick = 0;
      s.view.getState().setMode('pattern');
      await scrollHome();
    });

    it('turns the page as the playhead nears the right edge, gliding so it lands near the left', async () => {
      await scrollHome();
      play(0.5 * visible());
      await frames(3);
      await expect.poll(() => playheadX() / width(), EVENTUALLY).toBeCloseTo(0.5, 1);
      s.fakeEngine.startTick = 0.9 * visible();
      await frames(3);
      // On its way, not there in one jump.
      const mid = playheadX() / width();
      expect(mid).toBeLessThan(0.89);
      expect(mid).toBeGreaterThan(0.16);
      await until(nearLeft);
      // Saved for the next time once playback stops (after the glide lands).
      await new Promise((r) => setTimeout(r, 400));
      s.engine.stop();
      await frames(2);
      await expect.poll(() => s.editor.getState().playlist.scrollTick, EVENTUALLY).toBeCloseTo(0.75 * visible(), 0);
    });

    it('smooth style: holds the playhead near 40 % and scrolls with it every frame', async () => {
      s.prefs.getState().set({ followStyle: 'smooth' });
      await scrollHome();
      play(0.3 * visible());
      await frames(3);
      // Before the anchor: the view stays put (the playhead shows where it is in the song).
      expect(playheadX() / width()).toBeCloseTo(0.3, 1);
      // Past it: the view glides to put the playhead at the anchor, then moves with it.
      s.fakeEngine.startTick = 0.7 * visible();
      await until(() => Math.abs(playheadX() / width() - 0.4) < 0.02);
      for (const step of [0.72, 0.75, 0.8]) {
        s.fakeEngine.startTick = step * visible();
        await frames(2);
        await expect.poll(() => playheadX() / width(), EVENTUALLY).toBeCloseTo(0.4, 1);
      }
      s.engine.stop();
      s.prefs.getState().set({ followStyle: 'page' });
    });

    it('brings back a playhead that jumped off-screen (a loop or a seek); the toolbar toggle turns it off', async () => {
      await scrollHome();
      play(40 * BAR);
      await until(nearLeft);
      s.engine.stop();
      await frames(2);
      const toggle = host.querySelector<HTMLElement>('[data-window-type="playlist"] button[aria-pressed]')!;
      expect(toggle.getAttribute('data-hint')).toMatch(/^Follow playhead on/);
      await userEvent.click(toggle);
      expect(s.prefs.getState().followPlayhead).toBe(false);
      // Off: the view stays put and the playhead runs off it.
      play(80 * BAR);
      await frames(4);
      expect(playheadX()).toBeNaN();
      s.engine.stop();
      // The command (in the View menu, and what Studio runs) has a plain hint and takes on/off.
      expect(s.commands.get('view.followPlayhead')?.hint).toMatch(/playhead stays in view/);
      await s.commands.run('view.followPlayhead', true);
      expect(s.prefs.getState().followPlayhead).toBe(true);
    });

    it('a hand scroll pauses it until the playhead is back in view; playing again resumes it', async () => {
      await scrollHome();
      play(0.3 * visible());
      await frames(3);
      // Scroll on by hand, past the playhead (it goes off to the left): following waits…
      wheel(2 * width());
      await frames(2);
      expect(playheadX()).toBeNaN();
      s.fakeEngine.startTick = 0.5 * visible();
      await frames(6);
      expect(playheadX()).toBeNaN();
      // …until the playhead comes into view; then it follows and turns the page again.
      s.fakeEngine.startTick = 2.3 * visible();
      await new Promise((r) => setTimeout(r, 1300));
      await frames(2);
      s.fakeEngine.startTick = 2.95 * visible();
      await until(nearLeft);
      // Scrolled back the other way (playhead off to the right): it stays paused while playing…
      wheel(-1e7);
      s.fakeEngine.startTick = 3 * visible();
      await frames(6);
      expect(playheadX()).toBeNaN();
      // …and playing again picks it up at once.
      s.engine.stop();
      await frames(1);
      play(3 * visible());
      await until(nearLeft);
    });

    it('holds still while a menu is open, and catches up when it closes', async () => {
      await scrollHome();
      play(0.2 * visible());
      await frames(2);
      showContextMenu({ x: 300, y: 300 }, [{ label: 'Something', onSelect: () => {} }]);
      await until(() => !!menu());
      s.fakeEngine.startTick = 2.5 * visible();
      await frames(4);
      expect(playheadX()).toBeNaN();
      closeContextMenu();
      await until(nearLeft);
    });

    it('starting playback closes an open menu', async () => {
      showContextMenu({ x: 300, y: 300 }, [{ label: 'Something', onSelect: () => {} }]);
      await until(() => !!menu());
      await frames(2);
      play(0);
      await until(() => !menu());
    });
  });

  describe('pixel snap', () => {
    const wheel = (deltaY: number) =>
      grid().dispatchEvent(new WheelEvent('wheel', { deltaY, shiftKey: true, bubbles: true, cancelable: true }));
    /** Scrolls by hand a fractional amount; the view's scroll is saved to the store about 300 ms later. */
    const scrollBy = async (deltaY: number) => {
      const before = s.editor.getState().playlist.scrollTick;
      wheel(deltaY);
      await until(() => s.editor.getState().playlist.scrollTick !== before);
      return s.editor.getState().playlist.scrollTick;
    };

    it('draws the grid and the playhead at one whole-device-pixel offset, with the scroll still fractional', async () => {
      s.engine.stop();
      s.view.getState().setMode('song');
      s.prefs.getState().set({ followPlayhead: false });
      s.view.getState().setSongStart(9000);
      wheel(-1e7);
      await frames(2);
      const dpr = window.devicePixelRatio || 1;
      const canvas = gridEl.querySelector<HTMLCanvasElement>('canvas')!;
      const playheadEl = host.querySelector<HTMLElement>('[data-window-type="playlist"] [class*="playhead"]')!;
      const ppt = s.editor.getState().playlist.pxPerTick;
      for (const dy of [37.13, 61.7, 99.3]) {
        const scrollTick = await scrollBy(dy);
        await frames(2);
        expect(scrollTick % 1).not.toBe(0);
        // The drawn offset: the scroll in whole device pixels, shared by the grid canvas and the playhead.
        const snap = Number(canvas.dataset.snapPx);
        expect(Number.isInteger(snap)).toBe(true);
        expect(snap).toBe(Math.round(scrollTick * ppt * dpr));
        expect(Number(playheadEl.dataset.snapPx)).toBe(snap);
        // The line lands on a whole device pixel, exactly where the drawn grid puts the playhead tick (in view).
        expect(playheadEl.style.display).toBe('block');
        const x = Number(/translateX\(([-\d.]+)px\)/.exec(playheadEl.style.transform)?.[1]) - HEADER_WIDTH;
        const dev = (x + HEADER_WIDTH) * dpr;
        expect(Math.abs(dev - Math.round(dev))).toBeLessThan(1e-6);
        expect(x).toBeCloseTo(Math.round((9000 * ppt - snap / dpr) * dpr) / dpr, 6);
      }
      s.view.getState().setSongStart(0);
      s.prefs.getState().set({ followPlayhead: true });
      wheel(-1e7);
      await frames(2);
    });
  });
});
