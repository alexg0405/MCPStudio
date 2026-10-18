/**
 * Piano roll gestures that the other piano roll tests leave out (headless Chrome, the real React shell, test services
 * with the fake engine): the keys on the left (they sound), the event lane under the grid (draw values, right-drag to
 * reset), the chord stamp, toggling a note in the selection, notes sounding while they are drawn or dragged, and the
 * view (wheel zoom and scroll, middle-button pan, the scrollbar thumb).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { KEYS_WIDTH } from '@ui/features/piano-roll/controller';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const PX = 0.1; // a 1/16 step (240 ticks) is 24 px
const ROW_H = 20;
const TOP_ROW = 40; // key 87 at the top
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('piano roll gestures (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let pattern: PatternId;
  let channel: ChannelId;
  let grid: HTMLElement;
  let keys: HTMLElement;
  let laneHost: HTMLElement;
  let thumb: HTMLElement;
  let ruler: HTMLElement;
  const notes = (): Note[] => [...notesSorted(s.doc.getState().project.patterns[pattern]?.notes[channel])];
  const cursor = () => s.history.status().cursor;
  /** The center of grid cell (tick, key). */
  const at = (tick: number, key: number) => ({ x: tick * PX + 2, y: (127 - key - TOP_ROW) * ROW_H + ROW_H / 2 });
  const fire = (el: HTMLElement, type: string, p: { x: number; y: number }, init: PointerEventInit = {}) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
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
  const drag = (el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, init: PointerEventInit = {}) => {
    fire(el, 'pointerdown', from, init);
    for (let i = 1; i <= 4; i++) fire(el, 'pointermove', { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, init);
    fire(el, 'pointerup', to, init);
  };
  const wheel = (el: HTMLElement, p: { x: number; y: number }, init: WheelEventInit) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + p.x, clientY: r.top + p.y, ...init }));
  };
  const seed = (list: Pick<Note, 'tick' | 'key' | 'length'>[]): Note[] => {
    const made = list.map((n) => ({ id: newId.note(), velocity: 0.8, ...n }));
    s.history.transact('seed', (d) => addNotes(d, pattern, channel, made));
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
    const p = s.doc.getState().project;
    pattern = p.patternOrder[0] as PatternId;
    channel = Object.values(p.channels).find((c) => c.kind === 'instrument')!.id as ChannelId;
    s.view.getState().setCurrentPattern(pattern);
    s.session.getState().selectChannel(channel);
    s.editor.getState().setPianoRoll({ pxPerTick: PX, rowHeight: ROW_H, scrollTick: 0, scrollRow: TOP_ROW, snap: 'step', velocityLane: true, lane: 'velocity' });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'piano-roll');
    s.view.getState().setMaximized('piano-roll', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    const win = '[data-window-type="piano-roll"]';
    await until(() => !!host.querySelector(`${win} [class*="gridHost"]`));
    grid = host.querySelector<HTMLElement>(`${win} [class*="gridHost"]`)!;
    keys = host.querySelector<HTMLElement>(`${win} canvas[data-hint="Click a key to hear it"]`)!;
    laneHost = host.querySelector<HTMLElement>(`${win} [class*="velocityHost"]`)!;
    thumb = host.querySelector<HTMLElement>(`${win} [class*="hthumb"]`)!;
    ruler = host.querySelector<HTMLElement>(`${win} canvas[class*="ruler"]`)!;
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    const ids = notes().map((n) => n.id);
    if (ids.length) s.history.transact('clear', (d) => removeNotes(d, pattern, channel, ids));
    s.editor.getState().selectNotes([]);
    s.editor.getState().setPianoRoll({ tool: 'draw', chord: '', inversion: 0, lane: 'velocity', velocityLane: true });
    vi.restoreAllMocks();
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  describe('the keys on the left', () => {
    it('a key sounds while it is held, and sliding to another key plays that one instead', () => {
      const on = vi.spyOn(s.engine, 'previewNoteOn');
      const off = vi.spyOn(s.engine, 'previewNoteOff');
      const keyY = (key: number) => (127 - key - TOP_ROW) * ROW_H + ROW_H / 2;
      fire(keys, 'pointerdown', { x: KEYS_WIDTH - 1, y: keyY(60) });
      expect(on).toHaveBeenCalledTimes(1);
      expect(on.mock.calls[0]?.slice(0, 2)).toEqual([channel, 60]);
      // Clicking further right on a key plays it louder.
      expect(on.mock.calls[0]?.[2]).toBeCloseTo(0.35 + ((KEYS_WIDTH - 1) / KEYS_WIDTH) * 0.65, 5);
      fire(keys, 'pointermove', { x: KEYS_WIDTH - 1, y: keyY(60) });
      expect(on).toHaveBeenCalledTimes(1);
      fire(keys, 'pointermove', { x: KEYS_WIDTH - 1, y: keyY(62) });
      expect(off).toHaveBeenCalledTimes(1);
      expect(on).toHaveBeenCalledTimes(2);
      expect(on.mock.calls[1]?.[1]).toBe(62);
      fire(keys, 'pointerup', { x: KEYS_WIDTH - 1, y: keyY(62) });
      expect(off).toHaveBeenCalledTimes(2);
      // Nothing was written to the pattern.
      expect(notes()).toHaveLength(0);
    });

    it('drawing a note sounds it, and dragging a note sounds the key it lands on', () => {
      const on = vi.spyOn(s.engine, 'previewNoteOn');
      const off = vi.spyOn(s.engine, 'previewNoteOff');
      fire(grid, 'pointerdown', at(0, 64));
      expect(on.mock.calls.map((c) => c[1])).toEqual([64]);
      fire(grid, 'pointerup', at(0, 64));
      expect(off).toHaveBeenCalledTimes(1);
      expect(notes()).toHaveLength(1);
      s.editor.getState().setPianoRoll({ tool: 'select' });
      drag(grid, at(0, 64), at(0, 67));
      expect(on.mock.calls.map((c) => c[1])).toEqual([64, 64, 65, 66, 67]);
      expect(notes()[0]?.key).toBe(67);
    });
  });

  describe('the event lane', () => {
    const laneY = (t: number) => 3 + (1 - t) * (laneHeight() - 6);
    const laneHeight = () => laneHost.getBoundingClientRect().height;

    it('dragging across the lane sets the velocity of the notes under it in one undo step; a right-drag resets it', async () => {
      seed([
        { tick: 0, key: 60, length: 240 },
        { tick: 480, key: 62, length: 240 },
        { tick: 960, key: 64, length: 240 },
      ]);
      const before = cursor();
      // From the first note's column to the second's, at half height.
      drag(laneHost, { x: 0 * PX + 2, y: laneY(0.5) }, { x: 480 * PX + 2, y: laneY(0.5) });
      const velocities = notes().map((n) => n.velocity);
      expect(velocities[0]).toBeCloseTo(0.5, 1);
      expect(velocities[1]).toBeCloseTo(0.5, 1);
      expect(velocities[2]).toBe(0.8);
      expect(s.history.status().undoLabel).toBe('Velocity');
      await s.history.undo();
      expect(notes().map((n) => n.velocity)).toEqual([0.8, 0.8, 0.8]);
      expect(cursor()).toBe(before);
      // Right-drag: back to the default.
      drag(laneHost, { x: 2, y: laneY(0.2) }, { x: 960 * PX + 2, y: laneY(0.2) }, { button: 2, buttons: 2 });
      expect(notes().map((n) => n.velocity)).toEqual([100 / 128, 100 / 128, 100 / 128]);
    });

    it('with notes selected only they change; Esc is not needed: a cancelled pointer drops the values', async () => {
      const made = seed([
        { tick: 0, key: 60, length: 240 },
        { tick: 480, key: 62, length: 240 },
      ]);
      s.editor.getState().selectNotes([made[1]!.id]);
      drag(laneHost, { x: 2, y: laneY(0.3) }, { x: 480 * PX + 40, y: laneY(0.3) });
      const velocities = notes().map((n) => n.velocity);
      expect(velocities[0]).toBe(0.8);
      expect(velocities[1]).toBeCloseTo(0.3, 1);
      await s.history.undo();
      const before = cursor();
      fire(laneHost, 'pointerdown', { x: 2, y: laneY(0.9) });
      laneHost.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      expect(notes().map((n) => n.velocity)).toEqual([0.8, 0.8]);
      expect(cursor()).toBe(before);
    });

    it('the lane can show another value: pan runs both ways from the centre line', () => {
      seed([{ tick: 0, key: 60, length: 240 }]);
      s.editor.getState().setPianoRoll({ lane: 'pan' });
      drag(laneHost, { x: 2, y: laneY(1) }, { x: 3, y: laneY(1) });
      expect(notes()[0]?.pan).toBeCloseTo(1, 1);
    });
  });

  describe('selecting and stamping', () => {
    it('Ctrl-click toggles a note in the selection; Ctrl-drag adds a box to it', () => {
      const made = seed([
        { tick: 0, key: 60, length: 240 },
        { tick: 480, key: 62, length: 240 },
        { tick: 960, key: 64, length: 240 },
      ]);
      s.editor.getState().setPianoRoll({ tool: 'select' });
      const mod = { ctrlKey: true };
      fire(grid, 'pointerdown', at(0, 60), mod);
      fire(grid, 'pointerup', at(0, 60), mod);
      expect(s.editor.getState().noteSelection).toEqual([made[0]!.id]);
      fire(grid, 'pointerdown', at(480, 62), mod);
      fire(grid, 'pointerup', at(480, 62), mod);
      expect(s.editor.getState().noteSelection).toEqual([made[0]!.id, made[1]!.id]);
      fire(grid, 'pointerdown', at(0, 60), mod);
      fire(grid, 'pointerup', at(0, 60), mod);
      expect(s.editor.getState().noteSelection).toEqual([made[1]!.id]);
      drag(grid, { x: 900 * PX, y: at(0, 66).y }, { x: 1200 * PX, y: at(0, 62).y }, mod);
      expect(new Set(s.editor.getState().noteSelection)).toEqual(new Set([made[1]!.id, made[2]!.id]));
    });

    it('with a chord stamp a click draws the whole chord as one undo step ("Add chord")', async () => {
      s.editor.getState().setPianoRoll({ chord: 'major' });
      const before = cursor();
      fire(grid, 'pointerdown', at(0, 60));
      fire(grid, 'pointerup', at(0, 60));
      expect(notes().map((n) => n.key)).toEqual([60, 64, 67]);
      expect(s.history.status().undoLabel).toBe('Add chord');
      expect(s.editor.getState().noteSelection).toHaveLength(3);
      await s.history.undo();
      expect(cursor()).toBe(before);
    });
  });

  // These change the view itself (its zoom and scroll), so they come last and undo their own change.
  describe('the view', () => {
    const saved = async () => {
      await sleep(400);
      return s.editor.getState().pianoRoll;
    };

    it('Ctrl + wheel zooms the time axis, Alt + wheel the key height, a plain wheel scrolls', async () => {
      wheel(grid, { x: 0, y: 40 }, { deltaY: -100, ctrlKey: true });
      expect((await saved()).pxPerTick).toBeGreaterThan(PX);
      wheel(grid, { x: 0, y: 40 }, { deltaY: 100, ctrlKey: true });
      expect((await saved()).pxPerTick).toBeCloseTo(PX, 6);
      wheel(grid, { x: 20, y: 0 }, { deltaY: -100, altKey: true });
      expect((await saved()).rowHeight).toBeGreaterThan(ROW_H);
      wheel(grid, { x: 20, y: 0 }, { deltaY: 100, altKey: true });
      expect((await saved()).rowHeight).toBeCloseTo(ROW_H, 6);
      wheel(grid, { x: 20, y: 40 }, { deltaX: 300, deltaY: 0 });
      expect((await saved()).scrollTick).toBeCloseTo(300 / PX, 3);
      wheel(ruler, { x: 20, y: 8 }, { deltaX: -300, deltaY: 0 });
      expect((await saved()).scrollTick).toBe(0);
      wheel(laneHost, { x: 20, y: 8 }, { deltaY: 100, shiftKey: true });
      expect((await saved()).scrollTick).toBeCloseTo(100 / PX, 3);
      wheel(keys, { x: 20, y: 8 }, { deltaY: -100, shiftKey: true });
      expect((await saved()).scrollTick).toBe(0);
      const row = (await saved()).scrollRow as number;
      wheel(grid, { x: 20, y: 40 }, { deltaY: 100 });
      expect(((await saved()).scrollRow as number) - row).toBeCloseTo(100 / ROW_H, 3);
      wheel(grid, { x: 20, y: 40 }, { deltaY: -100 });
      expect((await saved()).scrollRow).toBeCloseTo(row, 6);
    });

    it('a middle-button drag pans the view', async () => {
      const middle = { button: 1, buttons: 4 };
      fire(grid, 'pointerdown', { x: 400, y: 100 }, middle);
      fire(grid, 'pointermove', { x: 350, y: 100 }, middle);
      fire(grid, 'pointerup', { x: 350, y: 100 }, { button: 1 });
      expect((await saved()).scrollTick).toBeCloseTo(50 / PX, 3);
      fire(grid, 'pointerdown', { x: 350, y: 100 }, middle);
      fire(grid, 'pointermove', { x: 400, y: 100 }, middle);
      fire(grid, 'pointerup', { x: 400, y: 100 }, { button: 1 });
      expect((await saved()).scrollTick).toBe(0);
      expect(notes()).toHaveLength(0);
    });

    it('dragging the scrollbar thumb scrolls the view', async () => {
      const r = thumb.getBoundingClientRect();
      const event = (type: string, dx: number) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: r.left + 3 + dx, clientY: r.top + 2 });
      thumb.dispatchEvent(event('pointerdown', 0));
      thumb.dispatchEvent(event('pointermove', 60));
      thumb.dispatchEvent(event('pointerup', 60));
      const moved = (await saved()).scrollTick;
      expect(moved).toBeGreaterThan(0);
      wheel(grid, { x: 20, y: 40 }, { deltaX: -1000000, deltaY: 0 });
      expect((await saved()).scrollTick).toBe(0);
    });
  });
});
