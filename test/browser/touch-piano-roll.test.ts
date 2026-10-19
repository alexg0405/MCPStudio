/**
 * Touch on the piano roll, with real fingers (Chrome's touch input through DevTools, `test/helpers/touch.ts`; headless Chrome,
 * the real React shell, test services with the fake engine): one finger draws and drags notes, two fingers pan, a pinch zooms
 * time and key height around its centre, a resting finger opens the note's menu, and the event lane takes a finger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { addNotes, removeNotes } from '@core/ops/notes';
import { notesSorted } from '@core/query/queries';
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
import { Fingers, insideOf, nextFrame, sleep, until } from '../helpers/touch';

const PX = 0.1; // a 1/16 step (240 ticks) is 24 px
const ROW_H = 20;
const TOP_ROW = 40; // key 87 at the top
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await nextFrame();
};

describe('piano roll with touch', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let stopTouch: () => void;
  let pattern: PatternId;
  let channel: ChannelId;
  let grid: HTMLElement;
  let laneHost: HTMLElement;
  let ruler: HTMLElement;
  let fingers: Fingers;
  const win = '[data-window-type="piano-roll"]';
  const notes = (): Note[] => [...notesSorted(s.doc.getState().project.patterns[pattern]?.notes[channel])];
  const view = () => s.editor.getState().pianoRoll;
  /** The centre of grid cell (tick, key) on the screen. */
  const at = (tick: number, key: number) => insideOf(grid, tick * PX + 2, (127 - key - TOP_ROW) * ROW_H + ROW_H / 2);
  /** The saved view as it was when the editor opened (the editor saves its live view 300 ms after the last change). */
  let baseline = '';
  /** Waits for the view to be saved after a gesture (a busy machine delays the timer), then a little more for later changes. */
  const settled = async (): Promise<void> => {
    await until(() => JSON.stringify(view()) !== baseline, 8000).catch(() => undefined);
    await sleep(450);
  };
  const seed = (list: Pick<Note, 'tick' | 'key' | 'length'>[]): Note[] => {
    const made = list.map((n) => ({ id: newId.note(), velocity: 0.8, ...n }));
    s.history.transact('seed', (d) => addNotes(d, pattern, channel, made));
    return made;
  };

  async function findElements(): Promise<void> {
    await until(() => !!host.querySelector(`${win} [class*="gridHost"]`));
    grid = host.querySelector<HTMLElement>(`${win} [class*="gridHost"]`)!;
    laneHost = host.querySelector<HTMLElement>(`${win} [class*="velocityHost"]`)!;
    ruler = host.querySelector<HTMLElement>(`${win} canvas[class*="ruler"]`)!;
    await frames(3);
  }

  /** Closes and opens the piano roll so its live view is the saved one (the editor reads it only when it opens). */
  async function reopenWithView(patch: Partial<ReturnType<typeof view>>): Promise<void> {
    s.view.getState().hideWindow('piano-roll');
    await frames(2);
    s.editor.getState().setPianoRoll({ pxPerTick: PX, rowHeight: ROW_H, scrollTick: 0, scrollRow: TOP_ROW, snap: 'step', tool: 'draw', velocityLane: true, lane: 'velocity', ...patch });
    openWindow(s, 'piano-roll');
    s.view.getState().setMaximized('piano-roll', true);
    await findElements();
    baseline = JSON.stringify(view());
  }

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    const p = s.doc.getState().project;
    pattern = p.patternOrder[0] as PatternId;
    channel = Object.values(p.channels).find((c) => c.kind === 'instrument')!.id as ChannelId;
    s.view.getState().setCurrentPattern(pattern);
    s.session.getState().selectChannel(channel);
    registerFeatures(s);
    installKeyboard(s);
    stopTouch = installTouch(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await reopenWithView({});
  });

  beforeEach(async () => {
    closeContextMenu();
    await fingers?.liftAll();
    fingers = new Fingers();
    const current = notes();
    if (current.length) s.history.transact('clear', (d) => removeNotes(d, pattern, channel, current.map((n) => n.id)));
    s.editor.getState().selectNotes([]);
    await reopenWithView({});
  });

  afterAll(async () => {
    await fingers.liftAll();
    stopTouch();
    root.unmount();
    host.remove();
  });

  it('marks the grid, the ruler and the event lane as touch surfaces', () => {
    for (const el of [grid, ruler, laneHost]) {
      expect(el.hasAttribute('data-touch-surface')).toBe(true);
      expect(getComputedStyle(el).touchAction).toBe('none');
    }
  });

  it('one finger draws a note with the draw tool, and drags a note it lands on', async () => {
    await fingers.tap(1, at(480, 72));
    await frames(2);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.tick).toBe(480);
    expect(notes()[0]!.key).toBe(72);
    const note = notes()[0]!;
    await fingers.pressAndDrag(1, at(500, 72), at(980, 74));
    await fingers.lift(1);
    await frames(2);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.tick).toBe(note.tick + 480);
    expect(notes()[0]!.key).toBe(74);
  });

  it('a second finger drops the note the first was drawing: two fingers pan and write nothing', async () => {
    const before = s.history.status().cursor;
    // The second finger lands right after the first has begun drawing (all sent before any is waited for: see Fingers).
    await Promise.all([fingers.press(1, at(480, 72)), fingers.move({ 1: at(560, 72) }), fingers.press(2, at(1200, 72))]);
    await fingers.dragTogether({ id: 1, to: at(480, 72) }, { id: 2, to: at(1200, 72) }, 2);
    await fingers.liftAll();
    await frames(2);
    expect(notes()).toHaveLength(0);
    expect(s.history.status().cursor).toBe(before);
  });

  it('two fingers pan the roll sideways and up and down', async () => {
    await fingers.pressTogether({ 1: at(2000, 76), 2: at(2600, 76) });
    // 120 px left and 60 px up: the view moves 120 px on in time and 3 keys down the keyboard.
    await fingers.dragTogether({ id: 1, to: { x: at(2000, 76).x - 120, y: at(2000, 76).y - 60 } }, { id: 2, to: { x: at(2600, 76).x - 120, y: at(2600, 76).y - 60 } });
    await fingers.liftAll();
    await settled();
    expect(view().scrollTick).toBeCloseTo(120 / PX, -1);
    expect(view().scrollRow).toBeCloseTo(TOP_ROW + 3, 1);
  });

  it('a pinch zooms time around the point between the fingers, and a vertical pinch makes the keys taller', async () => {
    const centre = at(3000, 76);
    const tickAtCentre = () => view().scrollTick + (centre.x - grid.getBoundingClientRect().left) / view().pxPerTick;
    const before = { zoom: view().pxPerTick, tick: tickAtCentre() };
    await fingers.pressTogether({ 1: { x: centre.x - 60, y: centre.y }, 2: { x: centre.x + 60, y: centre.y } });
    await fingers.dragTogether({ id: 1, to: { x: centre.x - 180, y: centre.y } }, { id: 2, to: { x: centre.x + 180, y: centre.y } });
    await fingers.liftAll();
    await settled();
    expect(view().pxPerTick / before.zoom).toBeGreaterThan(2.2);
    expect(view().pxPerTick / before.zoom).toBeLessThan(3.4);
    expect(tickAtCentre()).toBeCloseTo(before.tick, -2);

    const rowHeight = view().rowHeight;
    await fingers.pressTogether({ 1: { x: centre.x, y: centre.y - 40 }, 2: { x: centre.x, y: centre.y + 40 } });
    await fingers.dragTogether({ id: 1, to: { x: centre.x, y: centre.y - 90 } }, { id: 2, to: { x: centre.x, y: centre.y + 90 } });
    await fingers.liftAll();
    await settled();
    expect(view().rowHeight).toBeGreaterThan(rowHeight * 1.3);
  });

  it('a finger that rests on a note opens its menu, selects it, and leaves it where it is', async () => {
    const [made] = seed([{ tick: 960, key: 72, length: 480 }]);
    s.editor.getState().selectNotes([]);
    await fingers.press(1, at(1000, 72));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    expect(s.editor.getState().noteSelection).toEqual([made!.id]);
    await fingers.lift(1);
    await frames(2);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.tick).toBe(960);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('a finger that rests on an empty spot opens the spot menu and draws nothing', async () => {
    await fingers.press(1, at(1500, 74));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    await fingers.lift(1);
    await frames(2);
    expect(notes()).toHaveLength(0);
  });

  it('a finger drags values across the event lane, one undo step', async () => {
    seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 480, key: 74, length: 240 },
    ]);
    const lane = laneHost.getBoundingClientRect();
    const y = lane.top + lane.height * 0.2;
    await fingers.pressAndDrag(1, { x: lane.left + 1 * PX * 0 + 4, y }, { x: lane.left + 480 * PX + 20, y });
    await fingers.lift(1);
    await frames(2);
    expect(notes().every((n) => n.velocity > 0.7)).toBe(true);
    expect(s.history.status().undoLabel).toBeTruthy();
  });

  it('two fingers on the event lane only move and zoom time (its height is its value)', async () => {
    const lane = laneHost.getBoundingClientRect();
    const y = lane.top + lane.height / 2;
    await fingers.pressTogether({ 1: { x: lane.left + 300, y }, 2: { x: lane.left + 400, y } });
    await fingers.dragTogether({ id: 1, to: { x: lane.left + 180, y: y - 10 } }, { id: 2, to: { x: lane.left + 280, y: y - 10 } });
    await fingers.liftAll();
    await settled();
    expect(view().scrollTick).toBeCloseTo(120 / PX, -1);
    expect(view().scrollRow).toBe(TOP_ROW);
  });
});
