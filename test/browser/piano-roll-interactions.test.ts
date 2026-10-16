/**
 * Piano roll interactions (headless Chrome, the real React shell, test services with the fake engine):
 * every edit is exactly one undo step, Esc and a cancelled pointer leave the notes alone, the right
 * button erases or opens the menu as the tool says, and the selection survives an undo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { notesSorted } from '@core/query/queries';
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

describe('piano roll interactions (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let pattern: PatternId;
  let channel: ChannelId;
  let grid: HTMLElement;
  const notes = (): Note[] => [...notesSorted(s.doc.getState().project.patterns[pattern]?.notes[channel])];
  /** Newest undo entry's id: it changes with every new undo step. */
  const cursor = () => s.history.status().cursor;
  /** The center of grid cell (tick, key). */
  const at = (tick: number, key: number) => ({ x: tick * PX + 2, y: (127 - key - TOP_ROW) * ROW_H + ROW_H / 2 });
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
    for (let i = 1; i <= 4; i++) fire('pointermove', { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, init);
    fire('pointerup', to, init);
  };
  const click = (p: { x: number; y: number }, init: PointerEventInit = {}) => {
    fire('pointerdown', p, init);
    fire('pointerup', p, init);
  };
  const seed = (list: Pick<Note, 'tick' | 'key' | 'length'>[]): Note[] => {
    const made = list.map((n) => ({ id: newId.note(), velocity: 0.8, ...n }));
    s.history.transact('seed', (d) => addNotes(d, pattern, channel, made));
    return made;
  };
  const setTool = (tool: 'draw' | 'select' | 'delete' | 'mute' | 'slice' | 'paint') => s.editor.getState().setPianoRoll({ tool });

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
    s.editor.getState().setPianoRoll({ pxPerTick: PX, rowHeight: ROW_H, scrollTick: 0, scrollRow: TOP_ROW, snap: 'step', velocityLane: true });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'piano-roll');
    s.view.getState().setMaximized('piano-roll', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="piano-roll"] [class*="gridHost"]'));
    grid = host.querySelector<HTMLElement>('[data-window-type="piano-roll"] [class*="gridHost"]')!;
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    const ids = notes().map((n) => n.id);
    if (ids.length) {
      const { removeNotes } = await import('@core/ops/notes');
      s.history.transact('clear', (d) => removeNotes(d, pattern, channel, ids));
    }
    s.editor.getState().selectNotes([]);
    setTool('draw');
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('a click with the draw tool adds one note on the grid, as one undo step; the new note is selected', async () => {
    const before = cursor();
    click(at(960, 72));
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ tick: 960, key: 72 });
    expect(cursor()).not.toBe(before);
    expect(s.history.status().undoLabel).toBe('Add note');
    expect(s.editor.getState().noteSelection).toEqual([notes()[0]!.id]);
    await s.history.undo();
    expect(notes()).toHaveLength(0);
    expect(cursor()).toBe(before);
  });

  it('dragging a note moves it (one undo step); undo puts it back and keeps it selected', async () => {
    const [n] = seed([{ tick: 960, key: 72, length: 480 }]);
    const before = cursor();
    drag(at(960, 72), { x: at(960, 72).x + 96, y: at(960, 74).y });
    expect(notes()[0]).toMatchObject({ tick: 960 + 960, key: 74 });
    expect(s.history.status().undoLabel).toBe('Move note');
    await s.history.undo();
    expect(cursor()).toBe(before); // back at the seed step: exactly one step was undone
    expect(notes()[0]).toMatchObject({ tick: 960, key: 72 });
    expect(s.editor.getState().noteSelection).toEqual([n!.id]);
  });

  it('dragging several selected notes moves them together in one step', async () => {
    const made = seed([
      { tick: 0, key: 60, length: 240 },
      { tick: 480, key: 64, length: 240 },
      { tick: 960, key: 67, length: 240 },
    ]);
    s.editor.getState().selectNotes(made.map((n) => n.id));
    const before = cursor();
    drag(at(480, 64), { x: at(480, 64).x + 48, y: at(480, 66).y });
    expect(notes().map((n) => [n.tick, n.key])).toEqual([
      [480, 62],
      [960, 66],
      [1440, 69],
    ]);
    await s.history.undo();
    expect(notes().map((n) => [n.tick, n.key])).toEqual([
      [0, 60],
      [480, 64],
      [960, 67],
    ]);
    expect(cursor()).toBe(before);
    expect(s.editor.getState().noteSelection).toHaveLength(3);
  });

  it('Shift-dragging a note duplicates it (one step); Shift-clicking without moving does nothing', async () => {
    seed([{ tick: 960, key: 72, length: 480 }]);
    const before = cursor();
    click(at(960, 72), { shiftKey: true });
    expect(notes()).toHaveLength(1);
    expect(cursor()).toBe(before);
    drag(at(960, 72), { x: at(960, 72).x + 96, y: at(960, 72).y }, { shiftKey: true });
    expect(notes()).toHaveLength(2);
    expect(s.history.status().undoLabel).toBe('Duplicate notes');
    await s.history.undo();
    expect(notes()).toHaveLength(1);
    expect(cursor()).toBe(before);
  });

  it('dragging a note’s end resizes it (one undo step) and remembers the length for new notes', async () => {
    seed([{ tick: 960, key: 72, length: 480 }]);
    const endX = (960 + 480) * PX;
    drag({ x: endX - 2, y: at(960, 72).y }, { x: endX - 2 + 48, y: at(960, 72).y });
    expect(notes()[0]).toMatchObject({ tick: 960, length: 480 + 480 });
    expect(s.history.status().undoLabel).toBe('Resize notes');
    expect(s.editor.getState().pianoRoll.lastLength).toBe(960);
  });

  it('Esc during a move drops it: nothing changes and no undo step is added', async () => {
    seed([{ tick: 960, key: 72, length: 480 }]);
    const before = cursor();
    fire('pointerdown', at(960, 72));
    fire('pointermove', { x: at(960, 72).x + 96, y: at(960, 76).y });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fire('pointerup', { x: at(960, 72).x + 96, y: at(960, 76).y });
    expect(notes()[0]).toMatchObject({ tick: 960, key: 72 });
    expect(cursor()).toBe(before);
  });

  it('a cancelled pointer (it left the window, a touch was interrupted) ends the drag without committing', async () => {
    seed([{ tick: 960, key: 72, length: 480 }]);
    const before = cursor();
    fire('pointerdown', at(960, 72));
    fire('pointermove', { x: at(960, 72).x + 96, y: at(960, 76).y });
    fire('pointercancel', at(960, 76));
    expect(cursor()).toBe(before);
    // A later move with no button down does nothing to the note.
    fire('pointermove', { x: at(960, 72).x + 200, y: at(960, 80).y }, { buttons: 0 });
    expect(notes()[0]).toMatchObject({ tick: 960, key: 72 });
  });

  it('painting a run of notes is one undo step', async () => {
    setTool('paint');
    const before = cursor();
    drag(at(0, 65), { x: at(0, 65).x + 24 * 5, y: at(0, 65).y });
    expect(notes().length).toBeGreaterThanOrEqual(3);
    await s.history.undo();
    expect(notes()).toHaveLength(0);
    expect(cursor()).toBe(before);
  });

  it('right-click on a note erases it (one undo step); on an empty spot it opens the menu and changes nothing', async () => {
    seed([{ tick: 960, key: 72, length: 480 }]);
    const afterSeed = cursor();
    click(at(960, 72), { button: 2, buttons: 2 });
    expect(notes()).toHaveLength(0);
    expect(s.history.status().undoLabel).toBe('Delete notes');
    await s.history.undo();
    expect(notes()).toHaveLength(1);
    expect(cursor()).toBe(afterSeed);
    click(at(2400, 70), { button: 2, buttons: 2 });
    await until(() => !!document.querySelector('[role="menu"]'));
    expect(cursor()).toBe(afterSeed);
    expect(notes()).toHaveLength(1);
    closeContextMenu();
  });

  it('with the Select tool a right-click on a note opens its menu instead of erasing', async () => {
    seed([{ tick: 960, key: 72, length: 480 }]);
    setTool('select');
    click(at(960, 72), { button: 2, buttons: 2 });
    await until(() => !!document.querySelector('[role="menu"]'));
    expect(notes()).toHaveLength(1);
    closeContextMenu();
  });

  it('the Slice tool cuts a note in two (one undo step)', async () => {
    seed([{ tick: 960, key: 72, length: 960 }]);
    setTool('slice');
    const afterSeed = cursor();
    click({ x: (960 + 480) * PX, y: at(960, 72).y });
    expect(notes().map((n) => [n.tick, n.length])).toEqual([
      [960, 480],
      [1440, 480],
    ]);
    await s.history.undo();
    expect(notes()).toHaveLength(1);
    expect(cursor()).toBe(afterSeed);
  });

  it('the Mute tool toggles a dragged-over run of notes in one step', async () => {
    seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 480, key: 72, length: 240 },
      { tick: 960, key: 72, length: 240 },
    ]);
    setTool('mute');
    const afterSeed = cursor();
    drag(at(0, 72), at(960, 72));
    expect(notes().every((n) => n.muted)).toBe(true);
    await s.history.undo();
    expect(notes().some((n) => n.muted)).toBe(false);
    expect(cursor()).toBe(afterSeed);
  });

  it('a box drag with the Select tool selects the notes in it (not undoable)', () => {
    seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 960, key: 70, length: 240 },
      { tick: 3000, key: 50, length: 240 },
    ]);
    setTool('select');
    const before = cursor();
    drag({ x: 0, y: at(0, 74).y }, { x: 1500 * PX, y: at(0, 68).y });
    expect(s.editor.getState().noteSelection).toHaveLength(2);
    expect(cursor()).toBe(before);
  });

  it('drawing at very low zoom still lands on the grid line it is on', () => {
    s.editor.getState().setPianoRoll({ snap: 'bar' });
    click(at(BAR + 900, 66));
    expect(notes()[0]!.tick).toBe(BAR);
    s.editor.getState().setPianoRoll({ snap: 'step' });
  });
});
