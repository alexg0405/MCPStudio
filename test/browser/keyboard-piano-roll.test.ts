/**
 * The piano roll's keyboard cursor (headless Chrome, the real React shell, test services with the fake engine): Tab puts the
 * grid in reach with a name and a description, the arrow keys move a cursor by the snap step, notes are selected, put on
 * the grid, deleted, moved and resized from the keyboard with one undo step each, the cursor is drawn only while the
 * keyboard has the grid, the view scrolls to it in one jump, and every move says where it is for a screen reader.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement, Profiler } from 'react';
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
import { recentAnnouncements, resetAnnouncements } from '@ui/a11y/announce';
import { openWindow } from '@ui/workspace/registry';
import { EVENTUALLY, untilStill } from '../helpers/wait';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const PX = 0.1; // a 1/16 step (240 ticks) is 24 px
const ROW_H = 20;
const TOP_ROW = 40; // key 87 at the top
const BAR = 3840;
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

const CODES: Record<string, string> = { a: 'KeyA', '?': 'Slash', ' ': 'Space' };

describe('piano roll keyboard cursor (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let pattern: PatternId;
  let channel: ChannelId;
  let grid: HTMLElement;
  let overlay: HTMLCanvasElement;
  /** How many times React committed anything (the cursor must cost none). */
  let commits = 0;
  const notes = (): Note[] => [...notesSorted(s.doc.getState().project.patterns[pattern]?.notes[channel])];
  const cursor = () => s.history.status().cursor;
  const selected = (): number[] => notes().filter((n) => s.editor.getState().noteSelection.includes(n.id)).map((n) => n.tick);
  /** Presses a key on the focused grid; returns the event, so a test can see whether it was used (defaultPrevented). */
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, code: CODES[key] ?? key, bubbles: true, cancelable: true, ...init });
    grid.dispatchEvent(event);
    return event;
  };
  const seed = (list: Pick<Note, 'tick' | 'key' | 'length'>[]): Note[] => {
    const made = list.map((n) => ({ id: newId.note(), velocity: 0.8, ...n }));
    s.history.transact('seed', (d) => addNotes(d, pattern, channel, made));
    return made;
  };
  const lastSaid = () => recentAnnouncements().at(-1);
  const summary = () => grid.querySelector<HTMLElement>('[id^="ag-key-summary"]')?.textContent ?? '';
  /** Starts a test with the cursor on the first selected note, the way arriving by Tab does. */
  const focusOn = async (note: Note) => {
    s.editor.getState().selectNotes([note.id]);
    grid.blur();
    grid.focus();
    await expect.poll(() => grid.matches(':focus-visible'), EVENTUALLY).toBe(true);
    await expect.poll(summary, EVENTUALLY).toContain('Cursor at');
  };
  /** The box (CSS px) of everything painted on the overlay canvas, or null when it is blank. Idle, only the cursor is on it. */
  const paintedBox = (): { width: number; height: number } | null => {
    const { width, height } = overlay;
    const data = overlay.getContext('2d')!.getImageData(0, 0, width, height).data;
    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3]! === 0) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < 0) return null;
    const dpr = window.devicePixelRatio || 1;
    return { width: (right - left + 1) / dpr, height: (bottom - top + 1) / dpr };
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
    s.editor.getState().setPianoRoll({ pxPerTick: PX, rowHeight: ROW_H, scrollTick: 0, scrollRow: TOP_ROW, snap: 'step', lastLength: 960 });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'piano-roll');
    s.view.getState().setMaximized('piano-roll', true);
    root = createRoot(host);
    root.render(
      createElement(Profiler, { id: 'app', onRender: () => commits++ }, createElement(ServicesProvider, { services: s, children: createElement(App) })),
    );
    await until(() => !!host.querySelector('[data-window-type="piano-roll"] [class*="gridHost"]'));
    grid = host.querySelector<HTMLElement>('[data-window-type="piano-roll"] [class*="gridHost"]')!;
    overlay = grid.querySelectorAll('canvas')[2] as HTMLCanvasElement;
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    grid.blur();
    const ids = notes().map((n) => n.id);
    if (ids.length) s.history.transact('clear', (d) => removeNotes(d, pattern, channel, ids));
    s.editor.getState().selectNotes([]);
    s.editor.getState().setPianoRoll({ tool: 'draw', snap: 'step', lastLength: 960, scrollTick: 0, scrollRow: TOP_ROW });
    resetAnnouncements();
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('is one Tab stop with a name and a description of what it holds and where the cursor is', async () => {
    const made = seed([
      { tick: 960, key: 72, length: 240 },
      { tick: 1920, key: 74, length: 480 },
    ]);
    expect(grid.tabIndex).toBe(0);
    expect(grid.getAttribute('role')).toBe('application');
    expect(grid.getAttribute('aria-label')).toBe('Piano roll grid');
    expect(grid.getAttribute('aria-describedby')).toBe(grid.querySelector('[id^="ag-key-summary"]')!.id);
    await focusOn(made[0]!);
    expect(summary()).toContain('2 notes, 1 selected');
    expect(summary()).toContain('Cursor at C6, bar 1 beat 2.');
  });

  it('moves the cursor by the snap step and says where it is', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    press('ArrowRight');
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 1 beat 2 plus 1 step, empty');
    press('ArrowLeft');
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 1 beat 2, note 1/16, velocity 102, selected');
    press('ArrowUp');
    await expect.poll(lastSaid, EVENTUALLY).toBe('C sharp 6, bar 1 beat 2, empty');
    press('ArrowDown');
    press('ArrowDown');
    await expect.poll(lastSaid, EVENTUALLY).toBe('B5, bar 1 beat 2, empty');
  });

  it('jumps by a bar with Ctrl or Cmd and an octave with PageUp and PageDown, and goes to the ends with Home and End', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    press('ArrowRight', { ctrlKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 2 beat 1, empty');
    press('ArrowLeft', { metaKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 1 beat 1, empty');
    press('PageUp');
    await expect.poll(lastSaid, EVENTUALLY).toBe('C7, bar 1 beat 1, empty');
    press('PageDown');
    press('PageDown');
    await expect.poll(lastSaid, EVENTUALLY).toBe('C5, bar 1 beat 1, empty');
    press('ArrowUp', { ctrlKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 1 beat 1, empty');
    press('End');
    await expect.poll(lastSaid, EVENTUALLY).toBe(`C6, bar 2 beat 1, empty`);
    press('Home');
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 1 beat 1, empty');
  });

  it('Enter selects the note under the cursor and Enter again deselects it', async () => {
    const [first, second] = seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 240, key: 72, length: 240 },
    ]);
    await focusOn(first!);
    press('ArrowRight');
    press('Enter');
    await expect.poll(() => s.editor.getState().noteSelection.length, EVENTUALLY).toBe(2);
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 1 beat 1 plus 1 step, note 1/16, velocity 102, selected');
    press('Enter');
    await expect.poll(() => s.editor.getState().noteSelection, EVENTUALLY).toEqual([first!.id]);
    expect(second).toBeDefined();
  });

  it('Enter on an empty cell puts a note there, as long as the last one drawn, as one undo step', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 240 }]);
    await focusOn(note!);
    const before = cursor();
    press('ArrowRight', { ctrlKey: true });
    press('ArrowUp');
    press('Enter');
    await expect.poll(() => notes().length, EVENTUALLY).toBe(2);
    expect(notes()[1]).toMatchObject({ tick: BAR, key: 73, length: 960 });
    expect(s.history.status().undoLabel).toBe('Add note');
    expect(selected()).toEqual([BAR]);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Added C sharp 6, bar 2 beat 1, note 1/4');
    await s.history.undo();
    expect(notes()).toHaveLength(1);
    expect(cursor()).not.toBe(before - 1);
    expect(s.history.status().cursor).toBe(before);
  });

  it('Ctrl+Shift+Right selects across a bar, and Delete removes the selection in one undo step', async () => {
    const [a, b] = seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 480, key: 72, length: 240 },
    ]);
    await focusOn(a!);
    press('ArrowRight', { ctrlKey: true, shiftKey: true });
    await expect.poll(() => s.editor.getState().noteSelection.length, EVENTUALLY).toBe(2);
    const before = cursor();
    press('Delete');
    await expect.poll(() => notes().length, EVENTUALLY).toBe(0);
    expect(s.history.status().undoLabel).toBe('Delete notes');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Deleted 2 notes');
    await s.history.undo();
    expect(notes()).toHaveLength(2);
    expect(cursor()).toBe(before);
    expect(b).toBeDefined();
  });

  it('Delete with nothing selected removes the note under the cursor', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    s.editor.getState().selectNotes([]);
    press('Backspace');
    await expect.poll(() => notes().length, EVENTUALLY).toBe(0);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Deleted note C6, bar 1 beat 2');
  });

  it('Alt with the arrows moves the selected note by a step and a semitone, and the cursor goes with it', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    press('ArrowRight', { altKey: true });
    await expect.poll(() => notes()[0]?.tick, EVENTUALLY).toBe(1200);
    press('ArrowUp', { altKey: true });
    await expect.poll(() => notes()[0]?.key, EVENTUALLY).toBe(73);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Moved 1 note. C sharp 6, bar 1 beat 2 plus 1 step, note 1/16, velocity 102, selected');
    press('PageDown', { altKey: true });
    await expect.poll(() => notes()[0]?.key, EVENTUALLY).toBe(61);
    // The cursor kept up: Enter on it deselects the same note.
    press('Enter');
    await expect.poll(() => s.editor.getState().noteSelection.length, EVENTUALLY).toBe(0);
  });

  it('a held Alt+arrow (key repeat) moves the note many steps and undoes in one step', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 240 }]);
    await focusOn(note!);
    const before = cursor();
    press('ArrowRight', { altKey: true });
    for (let i = 0; i < 7; i++) press('ArrowRight', { altKey: true, repeat: true });
    await expect.poll(() => notes()[0]?.tick, EVENTUALLY).toBe(8 * 240);
    expect(s.history.status().undoLabel).toBe('Move note');
    await s.history.undo();
    expect(notes()[0]?.tick).toBe(0);
    expect(cursor()).toBe(before);
  });

  it('Alt+Shift+Left and Right make the selected note a grid step shorter or longer, never shorter than a step', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 480 }]);
    await focusOn(note!);
    press('ArrowRight', { altKey: true, shiftKey: true });
    await expect.poll(() => notes()[0]?.length, EVENTUALLY).toBe(720);
    await expect.poll(lastSaid, EVENTUALLY).toBe('1 note now 3/16 long');
    press('ArrowLeft', { altKey: true, shiftKey: true });
    press('ArrowLeft', { altKey: true, shiftKey: true });
    press('ArrowLeft', { altKey: true, shiftKey: true });
    await expect.poll(() => notes()[0]?.length, EVENTUALLY).toBe(240);
    expect(s.editor.getState().pianoRoll.lastLength).toBe(240);
  });

  it('Alt+Shift+Up and Down change the velocity', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 240 }]);
    await focusOn(note!);
    press('ArrowDown', { altKey: true, shiftKey: true });
    await expect.poll(() => notes()[0]?.velocity, EVENTUALLY).toBeCloseTo(0.8 - 8 / 128, 5);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Velocity 94');
  });

  it('Shift with the arrows grows the selection over the notes the cursor crosses', async () => {
    const [a] = seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 480, key: 72, length: 240 },
      { tick: 960, key: 72, length: 240 },
      { tick: 1440, key: 74, length: 240 },
    ]);
    await focusOn(a!);
    press('ArrowRight', { shiftKey: true });
    press('ArrowRight', { shiftKey: true });
    await expect.poll(selected, EVENTUALLY).toEqual([0, 480]);
    press('ArrowRight', { shiftKey: true });
    press('ArrowRight', { shiftKey: true });
    await expect.poll(selected, EVENTUALLY).toEqual([0, 480, 960]);
    await expect.poll(lastSaid, EVENTUALLY).toContain('3 notes selected');
    // Moving without Shift ends the extension; a new Shift move starts from there.
    press('ArrowRight');
    press('ArrowUp', { shiftKey: true });
    press('ArrowUp', { shiftKey: true });
  });

  it('Ctrl+A selects every note, Escape clears the selection, and Escape with none selected goes on to the app', async () => {
    const [a] = seed([
      { tick: 0, key: 72, length: 240 },
      { tick: 960, key: 60, length: 240 },
    ]);
    await focusOn(a!);
    press('a', { ctrlKey: true });
    await expect.poll(() => s.editor.getState().noteSelection.length, EVENTUALLY).toBe(2);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Selected all 2 notes');
    const used = press('Escape');
    expect(used.defaultPrevented).toBe(true);
    await expect.poll(() => s.editor.getState().noteSelection.length, EVENTUALLY).toBe(0);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Selection cleared');
    // Nothing is selected now: the cursor says nothing and leaves Escape to the rest of the app.
    const said = recentAnnouncements().length;
    press('Escape');
    await frames(3);
    expect(recentAnnouncements()).toHaveLength(said);
  });

  it('the question mark describes the cursor, the selection and the grid step at once', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    press('?', { shiftKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toContain('Piano roll of');
    expect(lastSaid()).toContain('1 note, 1 selected');
    expect(lastSaid()).toContain('Under the cursor: C6, bar 1 beat 2, note 1/16, velocity 102, selected');
    expect(lastSaid()).toContain('Grid step 1/16');
  });

  it('a held arrow key does not flood the screen reader: far fewer sentences than key presses, the last one correct', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 240 }]);
    await focusOn(note!);
    resetAnnouncements();
    for (let i = 0; i < 40; i++) press('ArrowRight', { repeat: i > 0 });
    await expect.poll(lastSaid, EVENTUALLY).toBe('C6, bar 3 beat 3, empty');
    expect(recentAnnouncements().length).toBeLessThan(6);
  });

  it('draws the cursor (a dashed box with corner ticks, around the note under it) only while the keyboard has the grid', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 480 }]);
    await frames(2);
    expect(paintedBox()).toBeNull();
    await focusOn(note!);
    await expect.poll(paintedBox, EVENTUALLY).not.toBeNull();
    // The note is 48 px by 20 px; the cursor stands out a little around it, with lines at least 2 px wide.
    const box = paintedBox()!;
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeLessThanOrEqual(60);
    expect(box.height).toBeGreaterThanOrEqual(20);
    expect(box.height).toBeLessThanOrEqual(30);
    grid.blur();
    await expect.poll(paintedBox, EVENTUALLY).toBeNull();
  });

  it('leaves the window’s own arrow shortcuts alone when the grid does not have keyboard focus (mouse users keep nudge and transpose)', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    s.editor.getState().selectNotes([note!.id]);
    (document.activeElement as HTMLElement | null)?.blur();
    s.view.getState().focusWindow(host.querySelector<HTMLElement>('[data-window-type="piano-roll"]')!.dataset.windowId!);
    press('ArrowUp');
    await expect.poll(() => notes()[0]?.key, EVENTUALLY).toBe(73);
    press('ArrowRight');
    await expect.poll(() => notes()[0]?.tick, EVENTUALLY).toBe(1200);
  });

  it('keeps Space for play and stop, and the tool letters for the tools', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    const wasPlaying = s.engine.playing;
    press(' ');
    await expect.poll(() => s.engine.playing, EVENTUALLY).toBe(!wasPlaying);
    press(' ');
    await expect.poll(() => s.engine.playing, EVENTUALLY).toBe(wasPlaying);
    press('e', { code: 'KeyE' });
    await expect.poll(() => s.editor.getState().pianoRoll.tool, EVENTUALLY).toBe('select');
  });

  it('the view jumps to the cursor in one step (no glide), and scrolling up and down by key does too', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 240 }]);
    await focusOn(note!);
    const thumb = grid.parentElement!.querySelector<HTMLElement>('[class*="hthumb"]')!;
    const before = thumb.style.transform;
    for (let i = 0; i < 6; i++) press('ArrowRight', { ctrlKey: true });
    await expect.poll(() => thumb.style.transform, EVENTUALLY).not.toBe(before);
    const settled = thumb.style.transform;
    await frames(20);
    expect(thumb.style.transform).toBe(settled);
    // The cursor is on screen: the saved scroll puts bar 7 inside the 1000 px view.
    await expect.poll(() => s.editor.getState().pianoRoll.scrollTick, EVENTUALLY).toBeGreaterThan(0);
    const scrollTick = s.editor.getState().pianoRoll.scrollTick;
    expect(6 * BAR).toBeGreaterThanOrEqual(scrollTick);
    expect(6 * BAR).toBeLessThanOrEqual(scrollTick + 1000 / PX);
    for (let i = 0; i < 30; i++) press('ArrowDown');
    await expect.poll(() => s.editor.getState().pianoRoll.scrollRow, EVENTUALLY).toBeGreaterThan(TOP_ROW);
  });

  it('moving the cursor causes no React commits (the cursor and the description live outside React)', async () => {
    const [note] = seed([{ tick: 0, key: 72, length: 240 }]);
    await focusOn(note!);
    await untilStill(() => commits);
    const before = commits;
    for (let i = 0; i < 12; i++) {
      press('ArrowRight');
      press('ArrowDown');
      press('ArrowLeft', { ctrlKey: true });
      press('ArrowUp');
    }
    await expect.poll(lastSaid, EVENTUALLY).toBeTruthy();
    await frames(10);
    expect(commits - before).toBe(0);
  });

  it('a click with the mouse hides the cursor and hands the arrow keys back to the window until the keyboard returns', async () => {
    const [note] = seed([{ tick: 960, key: 72, length: 240 }]);
    await focusOn(note!);
    await expect.poll(paintedBox, EVENTUALLY).not.toBeNull();
    s.editor.getState().setPianoRoll({ tool: 'select' }); // a click then only selects: it adds no note
    grid.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 0, clientY: 0 }));
    grid.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: 0, clientY: 0 }));
    await expect.poll(paintedBox, EVENTUALLY).toBeNull();
    s.editor.getState().selectNotes([note!.id]);
    resetAnnouncements();
    press('ArrowUp'); // the window's own shortcut: transposes the selected note
    await expect.poll(() => notes()[0]?.key, EVENTUALLY).toBe(73);
    expect(recentAnnouncements()).toHaveLength(0);
    // Tab away and back: the cursor is the keyboard's again.
    grid.blur();
    grid.focus();
    await expect.poll(paintedBox, EVENTUALLY).not.toBeNull();
  });
});
