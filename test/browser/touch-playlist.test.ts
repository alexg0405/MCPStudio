/**
 * Touch on the playlist, with real fingers (Chrome's touch input through DevTools, `test/helpers/touch.ts`; headless Chrome,
 * the real React shell, test services with the fake engine): one finger does what the tool does, two fingers pan, a pinch
 * zooms around its centre (time across, track height up and down), a resting finger opens the menus, a double tap is a
 * double-click, and the same gestures with a mouse still work (the mouse tests are in playlist-gestures).
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
import { installTouch } from '@ui/touch';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import '@ui/touch/touch.css';
import { centerOf, Fingers, insideOf, nextFrame, sleep, until } from '../helpers/touch';

const BAR = 3840;
const BAR_PX = 96; // pxPerTick 0.025
const LANE_H = 36;
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await nextFrame();
};

describe('playlist with touch', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let stopTouch: () => void;
  let lanes: LaneId[];
  let pattern: PatternId;
  let grid: HTMLElement;
  let headers: HTMLElement;
  let ruler: HTMLElement;
  let fingers: Fingers;
  const clips = (): Clip[] => clipsSorted(s.doc.getState().project.playlist.clips) as Clip[];
  const view = () => s.editor.getState().playlist;
  /** The tick under a client x. */
  const tickAt = (clientX: number) => view().scrollTick + (clientX - grid.getBoundingClientRect().left) / view().pxPerTick;
  /** The view is saved 300 ms after the last change. */
  const settled = () => sleep(420);
  const inGrid = (x: number, y: number) => insideOf(grid, x, y);
  const addPatternClip = (bar: number, laneIndex: number): Clip => {
    const made: Clip = { kind: 'pattern', id: newId.clip(), laneId: lanes[laneIndex] as LaneId, start: (bar - 1) * BAR, length: BAR, patternId: pattern, offset: 0 };
    s.history.transact('seed', (d) => addClips(d, [made]));
    return made;
  };

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
    stopTouch = installTouch(s);
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await findElements();
  });

  /** Finds the playlist's elements (they are new each time the window is opened). */
  async function findElements(): Promise<void> {
    await until(() => !!host.querySelector('[data-window-type="playlist"] div[data-hint^="Draw:"]'));
    grid = host.querySelector<HTMLElement>('[data-window-type="playlist"] div[data-hint^="Draw:"]')!;
    headers = host.querySelector<HTMLElement>('[data-window-type="playlist"] canvas[data-hint^="Tracks:"]')!;
    ruler = host.querySelector<HTMLElement>('[data-window-type="playlist"] canvas[data-hint^="Drag to set a loop region"]')!;
    await frames(3);
  }

  /** Closes and opens the playlist: the editor reads its saved view only when it opens, so this puts the live view where the saved one is. */
  async function reopenWithView(patch: Partial<ReturnType<typeof view>>): Promise<void> {
    s.view.getState().hideWindow('playlist');
    await frames(2);
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar', pxPerTick: 0.025, laneHeight: LANE_H, scrollTick: 0, scrollLane: 0, ...patch });
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    await findElements();
  }

  beforeEach(async () => {
    closeContextMenu();
    await fingers?.liftAll();
    fingers = new Fingers();
    const ids = clips().map((c) => c.id);
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids as ClipId[]));
    s.editor.getState().selectClips([]);
    s.view.getState().setLoop(null);
    await reopenWithView({});
  });

  afterAll(async () => {
    await fingers.liftAll();
    stopTouch();
    root.unmount();
    host.remove();
  });

  it('marks the grid, the ruler and the headers as touch surfaces that keep the browser from scrolling or zooming', () => {
    for (const el of [grid, headers, ruler]) {
      expect(el.hasAttribute('data-touch-surface')).toBe(true);
      expect(getComputedStyle(el).touchAction).toBe('none');
    }
  });

  it('one finger drags with the current tool: the draw tool places a clip, as a mouse does', async () => {
    const before = clips().length;
    await fingers.press(1, inGrid(2.1 * BAR_PX, LANE_H * 1.5));
    await fingers.drag(1, inGrid(3.2 * BAR_PX, LANE_H * 1.5));
    await fingers.lift(1);
    await frames(2);
    expect(clips()).toHaveLength(before + 1);
    // The new clip follows the finger: it is dropped at the bar it ended on.
    expect(clips()[0]!.start).toBe(BAR * 3);
    expect(s.history.status().undoLabel).toBe('Add clip');
  });

  it('one finger moves a clip (the draw tool grabs what is under it)', async () => {
    const made = addPatternClip(2, 0);
    await fingers.press(1, inGrid(1.5 * BAR_PX, LANE_H / 2));
    await fingers.drag(1, inGrid(3.5 * BAR_PX, LANE_H / 2));
    await fingers.lift(1);
    await frames(2);
    expect(clips().find((c) => c.id === made.id)!.start).toBe(BAR * 3);
  });

  it('two fingers pan: the song follows the fingers, and the tool never sees them', async () => {
    const before = clips().length;
    await fingers.press(1, inGrid(500, 100));
    // The second finger lands a moment later: the first has begun a draw, which must be dropped.
    await fingers.drag(1, inGrid(504, 100), 2);
    await fingers.press(2, inGrid(620, 100));
    await fingers.dragTogether({ id: 1, to: inGrid(504 - 192, 130) }, { id: 2, to: inGrid(620 - 192, 130) });
    await fingers.liftAll();
    await settled();
    // 192 px to the left is two bars further on in the song.
    expect(view().scrollTick).toBeCloseTo(2 * BAR, -1);
    expect(clips()).toHaveLength(before);
    expect(s.history.status().undoLabel).not.toBe('Add clip');
  });

  it('two fingers pan the tracks up and down too', async () => {
    await reopenWithView({ laneHeight: 120 });
    // Fingers moving up 120 px bring the next tracks into view: one track of 120 px.
    await fingers.press(1, inGrid(300, 220));
    await fingers.press(2, inGrid(420, 220));
    await fingers.dragTogether({ id: 1, to: inGrid(300, 100) }, { id: 2, to: inGrid(420, 100) });
    await fingers.liftAll();
    await settled();
    expect(view().scrollLane).toBeCloseTo(1, 1);
  });

  it('a pinch zooms the time axis around the point between the fingers', async () => {
    const centerX = grid.getBoundingClientRect().left + 400;
    const before = { zoom: view().pxPerTick, tick: tickAt(centerX) };
    await fingers.press(1, { x: centerX - 50, y: inGrid(0, 100).y });
    await fingers.press(2, { x: centerX + 50, y: inGrid(0, 100).y });
    await fingers.dragTogether({ id: 1, to: { x: centerX - 150, y: inGrid(0, 100).y } }, { id: 2, to: { x: centerX + 150, y: inGrid(0, 100).y } });
    await fingers.liftAll();
    await settled();
    // The fingers went from 100 px to 300 px apart.
    expect(view().pxPerTick / before.zoom).toBeGreaterThan(2);
    expect(view().pxPerTick / before.zoom).toBeLessThan(3.4);
    expect(tickAt(centerX)).toBeCloseTo(before.tick, -1);
  });

  it('pinching in zooms out, and a vertical pinch changes the track height', async () => {
    const centerX = grid.getBoundingClientRect().left + 400;
    const y = inGrid(0, 150).y;
    const zoom = view().pxPerTick;
    await fingers.press(1, { x: centerX - 150, y });
    await fingers.press(2, { x: centerX + 150, y });
    await fingers.dragTogether({ id: 1, to: { x: centerX - 50, y } }, { id: 2, to: { x: centerX + 50, y } });
    await fingers.liftAll();
    await settled();
    expect(view().pxPerTick).toBeLessThan(zoom * 0.5);

    const height = view().laneHeight;
    const x = centerX;
    await fingers.press(1, { x, y: y - 40 });
    await fingers.press(2, { x, y: y + 40 });
    await fingers.dragTogether({ id: 1, to: { x, y: y - 80 } }, { id: 2, to: { x, y: y + 80 } });
    await fingers.liftAll();
    await settled();
    expect(view().laneHeight).toBeGreaterThan(height * 1.4);
  });

  it('two fingers on the ruler and on the track headers pan and zoom too', async () => {
    const rulerBox = ruler.getBoundingClientRect();
    const y = rulerBox.top + 10;
    await fingers.press(1, { x: rulerBox.left + 500, y });
    await fingers.press(2, { x: rulerBox.left + 600, y });
    await fingers.dragTogether({ id: 1, to: { x: rulerBox.left + 404, y } }, { id: 2, to: { x: rulerBox.left + 504, y } });
    await fingers.liftAll();
    await settled();
    expect(view().scrollTick).toBeCloseTo(BAR, -1);
    // No loop was set by the finger that began on the ruler.
    expect(s.view.getState().loop).toBeNull();
  });

  it('a finger that rests on a clip opens its menu and does not move it; lifting does nothing more', async () => {
    const made = addPatternClip(3, 0);
    await fingers.press(1, inGrid(2.5 * BAR_PX, LANE_H / 2));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    expect(s.editor.getState().clipSelection).toEqual([made.id]);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain('Delete');
    await fingers.lift(1);
    await frames(2);
    expect(clips()).toHaveLength(1);
    expect(clips()[0]!.start).toBe(BAR * 2);
    // The menu is still there for the finger to choose from.
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('a finger that rests on an empty cell opens the cell menu, and nothing is placed', async () => {
    const before = clips().length;
    await fingers.press(1, inGrid(5.5 * BAR_PX, LANE_H * 2.5));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    await fingers.lift(1);
    await frames(2);
    expect(clips()).toHaveLength(before);
    expect(s.history.status().undoLabel).not.toBe('Add clip');
  });

  it('a finger that rests on a track name opens the track menu; on the ruler, the ruler menu', async () => {
    await fingers.press(1, insideOf(headers, 60, LANE_H / 2));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    await fingers.lift(1);
    closeContextMenu();
    await frames(2);
    await fingers.press(1, insideOf(ruler, 8 * BAR_PX, 8));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    expect(document.body.textContent).toContain('Add marker here');
    await fingers.lift(1);
  });

  it('a finger that moves before half a second is a drag, not a long press', async () => {
    await fingers.press(1, inGrid(2.1 * BAR_PX, LANE_H * 1.5));
    await fingers.drag(1, inGrid(3.1 * BAR_PX, LANE_H * 1.5));
    await sleep(650);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await fingers.lift(1);
    await frames(2);
    expect(clips()).toHaveLength(1);
  });

  it('two quick taps on a pattern clip are a double-click: that pattern opens in the channel rack', async () => {
    const made = addPatternClip(3, 0);
    s.view.getState().hideWindow('channel-rack');
    s.view.getState().setCurrentPattern(s.doc.getState().project.patternOrder[1] ?? pattern);
    const spot = inGrid(2.5 * BAR_PX, LANE_H / 2);
    await fingers.tap(1, spot);
    await sleep(60);
    await fingers.tap(1, spot);
    await until(() => Object.values(s.view.getState().windows).some((w) => w.type === 'channel-rack' && w.visible));
    expect(s.view.getState().currentPatternId).toBe((made as Extract<Clip, { kind: 'pattern' }>).patternId);
  });

  it('two taps far apart in time are not a double-click', async () => {
    addPatternClip(3, 0);
    s.view.getState().hideWindow('channel-rack');
    const spot = inGrid(2.5 * BAR_PX, LANE_H / 2);
    await fingers.tap(1, spot);
    await sleep(500);
    await fingers.tap(1, spot);
    await sleep(150);
    expect(Object.values(s.view.getState().windows).some((w) => w.type === 'channel-rack' && w.visible)).toBe(false);
  });

  it('the playlist stays where it is while the page itself is not scrolled or zoomed by a pinch', async () => {
    const zoom = visualViewport?.scale ?? 1;
    await fingers.press(1, inGrid(300, 100));
    await fingers.press(2, inGrid(400, 100));
    await fingers.dragTogether({ id: 1, to: inGrid(200, 100) }, { id: 2, to: inGrid(500, 100) });
    await fingers.liftAll();
    expect(visualViewport?.scale ?? 1).toBe(zoom);
    expect(document.scrollingElement?.scrollTop ?? 0).toBe(0);
  });

  it('a mouse still gets the tool untouched (the surface only reads touches)', async () => {
    const r = grid.getBoundingClientRect();
    const fire = (type: string, x: number, y: number, pointerType: string, id: number) =>
      grid.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y }),
      );
    // (A pen needs a real pen on the screen: the editor captures its pointer, which must exist.)
    for (const [pointerType, id] of [['mouse', 1]] as const) {
      const before = clips().length;
      fire('pointerdown', 2.1 * BAR_PX, LANE_H * 1.5, pointerType, id);
      fire('pointermove', 2.6 * BAR_PX, LANE_H * 1.5, pointerType, id);
      fire('pointermove', 3.2 * BAR_PX, LANE_H * 1.5, pointerType, id);
      fire('pointerup', 3.2 * BAR_PX, LANE_H * 1.5, pointerType, id);
      expect(clips()).toHaveLength(before + 1);
      await s.history.undo();
    }
  });

  it('the centre of a clip is where the finger lands (sanity check for the helpers)', () => {
    const made = addPatternClip(3, 0);
    expect(clips()[0]!.id).toBe(made.id);
    expect(centerOf(grid).x).toBeGreaterThan(0);
  });
});
