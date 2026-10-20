/**
 * The playlist's keyboard cursor (headless Chrome, the real React shell, test services with the fake engine): Tab puts the
 * grid in reach with a name and a description, the arrow keys move a cursor by the snap step and by track, clips are
 * selected, placed, deleted, moved and resized from the keyboard with one undo step each, markers and automation points
 * can be reached too, the cursor is drawn only while the keyboard has the grid, and every move says where it is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { newId } from '@core/model/ids';
import type { AutomationChannel, Clip, ClipId, LaneId, MarkerId, PatternId } from '@core/model/types';
import { createAutomationClip } from '@core/ops/automation';
import { removeMarker } from '@core/ops/markers';
import { addClips, removeClips } from '@core/ops/playlist';
import { clipsSorted } from '@core/query/playlist';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { markerRename } from '@ui/features/playlist/markers';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { recentAnnouncements, resetAnnouncements } from '@ui/a11y/announce';
import { openWindow } from '@ui/workspace/registry';
import { EVENTUALLY } from '../helpers/wait';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const BAR = 3840;
const BEAT = 960;
const LANE_H = 36;
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

describe('playlist keyboard cursor (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let lanes: LaneId[];
  let pattern: PatternId;
  let patternName: string;
  let grid: HTMLElement;
  let overlay: HTMLCanvasElement;
  const clips = (): Clip[] => clipsSorted(s.doc.getState().project.playlist.clips) as Clip[];
  const markers = () => Object.values(s.doc.getState().project.playlist.markers);
  const cursor = () => s.history.status().cursor;
  const selectedStarts = (): number[] => clips().filter((c) => s.editor.getState().clipSelection.includes(c.id)).map((c) => c.start);
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, code: CODES[key] ?? key, bubbles: true, cancelable: true, ...init });
    grid.dispatchEvent(event);
    return event;
  };
  const seed = (list: { bar: number; lane: number; bars: number }[]): Clip[] => {
    const made = list.map(
      (c): Clip => ({ kind: 'pattern', id: newId.clip(), laneId: lanes[c.lane] as LaneId, start: (c.bar - 1) * BAR, length: c.bars * BAR, patternId: pattern, offset: 0 }),
    );
    s.history.transact('seed', (d) => addClips(d, made));
    return made;
  };
  const setSnap = (snap: 'bar' | 'beat') => s.editor.getState().setPlaylist({ snap });
  const lastSaid = () => recentAnnouncements().at(-1);
  const summary = () => grid.querySelector<HTMLElement>('[id^="ag-key-summary"]')?.textContent ?? '';
  /** Starts a test with the cursor on a clip, the way arriving by Tab with that clip selected does. */
  const focusOn = async (clip: Clip) => {
    s.editor.getState().selectClips([clip.id]);
    grid.blur();
    grid.focus();
    await expect.poll(() => grid.matches(':focus-visible'), EVENTUALLY).toBe(true);
    await expect.poll(summary, EVENTUALLY).toContain('Cursor on');
  };
  /** Focuses the grid with the cursor at the left of the first track and nothing selected. */
  const focusEmpty = async () => {
    s.editor.getState().selectClips([]);
    grid.blur();
    grid.focus();
    await expect.poll(() => grid.matches(':focus-visible'), EVENTUALLY).toBe(true);
  };
  /** The size of everything painted on the overlay canvas (CSS px), or null when it is blank. Idle, only the cursor is on it. */
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
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar', pxPerTick: 0.025, laneHeight: LANE_H, scrollTick: 0, scrollLane: 0 });
    const p = s.doc.getState().project;
    lanes = p.playlist.laneOrder as LaneId[];
    pattern = p.patternOrder[0] as PatternId;
    patternName = p.patterns[pattern]!.name;
    s.view.getState().setCurrentPattern(pattern);
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="playlist"] div[data-hint^="Draw:"]'));
    grid = host.querySelector<HTMLElement>('[data-window-type="playlist"] div[data-hint^="Draw:"]')!;
    overlay = grid.querySelectorAll('canvas')[2] as HTMLCanvasElement;
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    grid.blur();
    const ids = clips().map((c) => c.id);
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids as ClipId[]));
    const markerIds = markers().map((m) => m.id);
    if (markerIds.length) s.history.transact('clear markers', (d) => markerIds.forEach((id) => removeMarker(d, id as MarkerId)));
    markerRename.setState({ id: null });
    s.editor.getState().selectClips([]);
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar', scrollTick: 0, scrollLane: 0 });
    resetAnnouncements();
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('is one Tab stop with a name and a description of what it holds and where the cursor is', async () => {
    const made = seed([
      { bar: 2, lane: 0, bars: 2 },
      { bar: 1, lane: 1, bars: 1 },
    ]);
    expect(grid.tabIndex).toBe(0);
    expect(grid.getAttribute('role')).toBe('application');
    expect(grid.getAttribute('aria-label')).toBe('Playlist grid');
    expect(grid.getAttribute('aria-describedby')).toBe(grid.querySelector('[id^="ag-key-summary"]')!.id);
    await focusOn(made[0]!);
    expect(summary()).toContain(`Playlist: 2 clips on ${lanes.length} tracks, 1 selected.`);
    expect(summary()).toContain('Cursor on track 1, bar 2 beat 1.');
  });

  it('moves the cursor by the snap step and by track and says where it is', async () => {
    const [clip] = seed([{ bar: 2, lane: 0, bars: 2 }]);
    await focusOn(clip!);
    await expect.poll(() => grid.matches(':focus-visible')).toBe(true);
    press('ArrowRight');
    await expect.poll(lastSaid, EVENTUALLY).toBe(`Track 1, bar 3 beat 1, inside clip ${patternName} that starts at bar 2 beat 1, 2 bars, selected`);
    press('ArrowRight');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 4 beat 1, empty');
    press('ArrowDown');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 2, bar 4 beat 1, empty');
    press('ArrowLeft');
    press('ArrowLeft');
    press('ArrowLeft');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 2, bar 1 beat 1, empty');
    press('ArrowLeft');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 2, bar 1 beat 1, empty');
  });

  it('moves by beats when the snap is a beat, by bars with Ctrl or PageDown, by four tracks with Ctrl+Down, and goes to the ends with Home and End', async () => {
    const [clip] = seed([{ bar: 3, lane: 0, bars: 1 }]);
    setSnap('beat');
    await focusOn(clip!);
    press('ArrowRight');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 3 beat 2, inside clip ' + patternName + ' that starts at bar 3 beat 1, 1 bar, selected');
    press('ArrowRight', { ctrlKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 4 beat 1, empty');
    press('PageUp');
    await expect.poll(lastSaid, EVENTUALLY).toBe(`Track 1, bar 3 beat 1, clip ${patternName}, 1 bar, selected`);
    press('PageDown');
    press('PageDown');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 5 beat 1, empty');
    press('ArrowDown', { ctrlKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 5, bar 5 beat 1, empty');
    press('ArrowUp', { metaKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 5 beat 1, empty');
    press('End');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 4 beat 1, empty');
    press('Home');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 1 beat 1, empty');
  });

  it('Enter selects the clip under the cursor and makes its pattern current; Enter again deselects it', async () => {
    const [a, b] = seed([
      { bar: 1, lane: 0, bars: 1 },
      { bar: 3, lane: 0, bars: 1 },
    ]);
    await focusOn(a!);
    press('ArrowRight', { ctrlKey: true });
    press('ArrowRight', { ctrlKey: true });
    press('Enter');
    await expect.poll(() => s.editor.getState().clipSelection.length, EVENTUALLY).toBe(2);
    await expect.poll(lastSaid, EVENTUALLY).toBe(`Track 1, bar 3 beat 1, clip ${patternName}, 1 bar, selected`);
    expect(s.view.getState().currentPatternId).toBe(pattern);
    press('Enter');
    await expect.poll(() => s.editor.getState().clipSelection, EVENTUALLY).toEqual([a!.id]);
    expect(b).toBeDefined();
  });

  it('Enter on an empty cell places a clip of the current pattern there, as one undo step', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    const before = cursor();
    press('ArrowRight');
    press('ArrowDown');
    press('Enter');
    await expect.poll(() => clips().length, EVENTUALLY).toBe(2);
    expect(clips()[1]).toMatchObject({ kind: 'pattern', start: BAR, laneId: lanes[1], patternId: pattern });
    expect(s.history.status().undoLabel).toBe('Add clip');
    expect(selectedStarts()).toEqual([BAR]);
    await expect.poll(lastSaid, EVENTUALLY).toContain(`Added clip ${patternName}`);
    expect(lastSaid()).toContain('Track 2, bar 2 beat 1');
    await s.history.undo();
    expect(clips()).toHaveLength(1);
    expect(cursor()).toBe(before);
  });

  it('Insert will not put a clip on top of another', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    press('Insert');
    await expect.poll(lastSaid, EVENTUALLY).toBe(`There is already clip ${patternName} here.`);
    expect(clips()).toHaveLength(1);
  });

  it('Delete removes the selected clips in one undo step, or the clip under the cursor when none is selected', async () => {
    const [a] = seed([
      { bar: 1, lane: 0, bars: 1 },
      { bar: 2, lane: 0, bars: 1 },
      { bar: 3, lane: 1, bars: 1 },
    ]);
    await focusOn(a!);
    press('ArrowRight', { shiftKey: true });
    await expect.poll(() => s.editor.getState().clipSelection.length, EVENTUALLY).toBe(2);
    const before = cursor();
    press('Delete');
    await expect.poll(() => clips().length, EVENTUALLY).toBe(1);
    expect(s.history.status().undoLabel).toBe('Delete clips');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Deleted 2 clips');
    await s.history.undo();
    expect(clips()).toHaveLength(3);
    expect(cursor()).toBe(before);
    s.editor.getState().selectClips([]);
    press('Backspace');
    await expect.poll(() => clips().length, EVENTUALLY).toBe(2);
    await expect.poll(lastSaid, EVENTUALLY).toBe(`Deleted clip ${patternName}, bar 2 beat 1`);
  });

  it('Alt with the arrows moves the selected clips a step and a track, and the cursor goes with them', async () => {
    const [clip] = seed([{ bar: 2, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    press('ArrowRight', { altKey: true });
    await expect.poll(() => clips()[0]?.start, EVENTUALLY).toBe(2 * BAR);
    press('ArrowDown', { altKey: true });
    await expect.poll(() => clips()[0]?.laneId, EVENTUALLY).toBe(lanes[1]);
    await expect.poll(lastSaid, EVENTUALLY).toBe(`Moved 1 clip. Track 2, bar 3 beat 1, clip ${patternName}, 1 bar, selected`);
    press('ArrowLeft', { altKey: true });
    press('ArrowLeft', { altKey: true });
    press('ArrowLeft', { altKey: true });
    await expect.poll(() => clips()[0]?.start, EVENTUALLY).toBe(0);
    press('ArrowLeft', { altKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toBe('Cannot move further that way.');
    press('ArrowUp', { altKey: true });
    await expect.poll(() => clips()[0]?.laneId, EVENTUALLY).toBe(lanes[0]);
  });

  it('a held Alt+arrow (key repeat) moves the clip many steps and undoes in one step', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    const before = cursor();
    press('ArrowRight', { altKey: true });
    for (let i = 0; i < 6; i++) press('ArrowRight', { altKey: true, repeat: true });
    await expect.poll(() => clips()[0]?.start, EVENTUALLY).toBe(7 * BAR);
    expect(s.history.status().undoLabel).toBe('Move clip');
    await s.history.undo();
    expect(clips()[0]?.start).toBe(0);
    expect(cursor()).toBe(before);
  });

  it('Alt+Shift+Left and Right make the selected clip a grid step shorter or longer, never shorter than a step', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 2 }]);
    await focusOn(clip!);
    press('ArrowRight', { altKey: true, shiftKey: true });
    await expect.poll(() => clips()[0]?.length, EVENTUALLY).toBe(3 * BAR);
    await expect.poll(lastSaid, EVENTUALLY).toBe('1 clip now 3 bars long');
    for (let i = 0; i < 4; i++) press('ArrowLeft', { altKey: true, shiftKey: true });
    await expect.poll(() => clips()[0]?.length, EVENTUALLY).toBe(BAR);
    expect(clips()[0]?.start).toBe(0);
  });

  it('Shift with the arrows grows the selection over the clips in the cells the cursor crosses', async () => {
    const [a] = seed([
      { bar: 1, lane: 0, bars: 1 },
      { bar: 2, lane: 0, bars: 1 },
      { bar: 2, lane: 1, bars: 1 },
      { bar: 3, lane: 2, bars: 1 },
    ]);
    await focusOn(a!);
    press('ArrowRight', { shiftKey: true });
    await expect.poll(() => selectedStarts(), EVENTUALLY).toEqual([0, BAR]);
    press('ArrowDown', { shiftKey: true });
    await expect.poll(() => selectedStarts().length, EVENTUALLY).toBe(3);
    await expect.poll(lastSaid, EVENTUALLY).toContain('3 clips selected');
  });

  it('Ctrl+A selects every clip, Escape clears the selection, and Escape with none selected says nothing', async () => {
    const [a] = seed([
      { bar: 1, lane: 0, bars: 1 },
      { bar: 5, lane: 3, bars: 1 },
    ]);
    await focusOn(a!);
    press('a', { ctrlKey: true });
    await expect.poll(() => s.editor.getState().clipSelection.length, EVENTUALLY).toBe(2);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Selected all 2 clips');
    press('Escape');
    await expect.poll(() => s.editor.getState().clipSelection.length, EVENTUALLY).toBe(0);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Selection cleared');
    const said = recentAnnouncements().length;
    press('Escape');
    await frames(3);
    expect(recentAnnouncements()).toHaveLength(said);
  });

  it('the marker lane is above the first track: Insert adds a marker, Enter renames it, Alt+arrows move it, Delete removes it', async () => {
    await focusEmpty();
    press('ArrowRight');
    press('ArrowUp');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Markers, bar 2 beat 1, empty');
    press('Insert');
    await expect.poll(() => markers().length, EVENTUALLY).toBe(1);
    expect(markers()[0]).toMatchObject({ tick: BAR, name: 'Marker 1' });
    await expect.poll(lastSaid, EVENTUALLY).toBe('Added marker Marker 1, bar 2 beat 1. Press Enter on it to rename it.');
    press('Enter');
    // The name field opens on the marker with the keyboard in it; Escape closes it and the cursor has the keyboard again.
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Marker name"]')!;
    await expect.poll(() => document.activeElement === field, EVENTUALLY).toBe(true);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Renaming marker Marker 1. Type a new name and press Enter.');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect.poll(() => document.activeElement === grid, EVENTUALLY).toBe(true);
    await expect.poll(() => grid.matches(':focus-visible'), EVENTUALLY).toBe(true);
    press('ArrowRight', { altKey: true });
    await expect.poll(() => markers()[0]?.tick, EVENTUALLY).toBe(2 * BAR);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Moved marker Marker 1. Markers, bar 3 beat 1, marker Marker 1');
    press('Delete');
    await expect.poll(() => markers().length, EVENTUALLY).toBe(0);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Deleted marker Marker 1');
    press('ArrowDown');
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 3 beat 1, empty');
  });

  describe('automation points', () => {
    /** A tempo automation clip on the first track from bar 2 for 2 bars: points at the start (20%), after a bar (90%) and at the end (50%). */
    const seedAutomation = (): Clip => {
      let clip!: Clip;
      s.history.transact('seed automation', (d) => {
        const made = createAutomationClip(d, {
          target: { kind: 'tempo' },
          name: 'Tempo',
          color: '#a0c0e0',
          start: BAR,
          length: 2 * BAR,
          points: [
            { tick: 0, value: 0.2 },
            { tick: BAR, value: 0.9 },
            { tick: 2 * BAR, value: 0.5 },
          ],
          range: { min: 60, max: 180 },
          laneId: lanes[0] as LaneId,
        });
        clip = d.playlist.clips[made.clipId] as Clip;
      });
      return clip;
    };
    const points = (clip: Clip) => {
      const channel = s.doc.getState().project.channels[(clip as { channelId: AutomationChannel['id'] }).channelId] as AutomationChannel;
      return channel.points;
    };

    it('says which point the cursor is on, adds a point, changes its value and removes it', async () => {
      const clip = seedAutomation();
      setSnap('beat');
      await focusOn(clip);
      press('Escape'); // clip deselected, so Delete means a point
      await expect.poll(() => s.editor.getState().clipSelection.length, EVENTUALLY).toBe(0);
      await expect.poll(lastSaid, EVENTUALLY).toBe('Selection cleared');
      press('ArrowLeft');
      press('ArrowRight');
      await expect.poll(lastSaid, EVENTUALLY).toContain('automation clip Tempo');
      expect(lastSaid()).toContain('point 1 of 3');
      press('ArrowRight');
      await expect.poll(lastSaid, EVENTUALLY).toContain('inside automation clip Tempo');
      expect(lastSaid()).not.toContain('point');
      press('Insert');
      await expect.poll(() => points(clip).length, EVENTUALLY).toBe(4);
      expect(s.history.status().undoLabel).toBe('Add automation point');
      expect(points(clip)[1]).toMatchObject({ tick: BEAT });
      await expect.poll(lastSaid, EVENTUALLY).toContain('Added point 2 of 4');
      const added = points(clip)[1]!.value;
      press('ArrowUp', { altKey: true, shiftKey: true });
      await expect.poll(() => points(clip)[1]!.value, EVENTUALLY).toBeCloseTo(added + 0.05, 5);
      s.editor.getState().selectClips([]);
      press('Delete');
      await expect.poll(() => points(clip).length, EVENTUALLY).toBe(3);
      await expect.poll(lastSaid, EVENTUALLY).toBe('Deleted point 2');
      expect(clips()).toHaveLength(1);
    });
  });

  it('the question mark describes the cursor, the selection and the grid step at once', async () => {
    const [clip] = seed([{ bar: 2, lane: 0, bars: 2 }]);
    await focusOn(clip!);
    press('?', { shiftKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toContain('Playlist: 1 clip on');
    expect(lastSaid()).toContain(`Under the cursor: Track 1, bar 2 beat 1, clip ${patternName}, 2 bars, selected`);
    expect(lastSaid()).toContain('Grid step 1 bar');
  });

  it('a held arrow key does not flood the screen reader: far fewer sentences than key presses, the last one correct', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    setSnap('beat');
    resetAnnouncements();
    for (let i = 0; i < 40; i++) press('ArrowRight', { repeat: i > 0 });
    await expect.poll(lastSaid, EVENTUALLY).toBe('Track 1, bar 11 beat 1, empty');
    expect(recentAnnouncements().length).toBeLessThan(6);
  });

  it('draws the cursor (a dashed box with corner ticks, around the clip under it) only while the keyboard has the grid', async () => {
    const [clip] = seed([{ bar: 2, lane: 0, bars: 2 }]);
    await frames(2);
    expect(paintedBox()).toBeNull();
    await focusOn(clip!);
    await expect.poll(paintedBox, EVENTUALLY).not.toBeNull();
    // The clip is 192 px by 34 px; the cursor stands out a little around it, with lines at least 2 px wide.
    const box = paintedBox()!;
    expect(box.width).toBeGreaterThanOrEqual(192);
    expect(box.width).toBeLessThanOrEqual(205);
    expect(box.height).toBeGreaterThanOrEqual(34);
    expect(box.height).toBeLessThanOrEqual(44);
    grid.blur();
    await expect.poll(paintedBox, EVENTUALLY).toBeNull();
  });

  it('leaves the window’s own shortcuts alone when the grid does not have keyboard focus (mouse users keep Delete)', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    s.editor.getState().selectClips([clip!.id]);
    (document.activeElement as HTMLElement | null)?.blur();
    s.view.getState().focusWindow(host.querySelector<HTMLElement>('[data-window-type="playlist"]')!.dataset.windowId!);
    press('Delete');
    await expect.poll(() => clips().length, EVENTUALLY).toBe(0);
    expect(recentAnnouncements()).toHaveLength(0);
  });

  it('keeps Space for play and stop, and the tool letters for the tools', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    const wasPlaying = s.engine.playing;
    press(' ');
    await expect.poll(() => s.engine.playing, EVENTUALLY).toBe(!wasPlaying);
    press(' ');
    await expect.poll(() => s.engine.playing, EVENTUALLY).toBe(wasPlaying);
    press('e', { code: 'KeyE' });
    await expect.poll(() => s.editor.getState().playlist.tool, EVENTUALLY).toBe('select');
  });

  it('the view jumps to the cursor in one step (no glide)', async () => {
    const [clip] = seed([{ bar: 1, lane: 0, bars: 1 }]);
    await focusOn(clip!);
    const thumb = grid.parentElement!.querySelector<HTMLElement>('[class*="hthumb"]')!;
    const before = thumb.style.transform;
    for (let i = 0; i < 20; i++) press('ArrowRight', { ctrlKey: true });
    await expect.poll(() => thumb.style.transform, EVENTUALLY).not.toBe(before);
    const settled = thumb.style.transform;
    await frames(20);
    expect(thumb.style.transform).toBe(settled);
    await expect.poll(() => s.editor.getState().playlist.scrollTick, EVENTUALLY).toBeGreaterThan(0);
    const scrollTick = s.editor.getState().playlist.scrollTick;
    const cursorTick = 20 * BAR;
    expect(cursorTick).toBeGreaterThanOrEqual(scrollTick);
    expect(cursorTick).toBeLessThanOrEqual(scrollTick + grid.getBoundingClientRect().width / 0.025);
    for (let i = 0; i < 40; i++) press('ArrowDown');
    await expect.poll(() => s.editor.getState().playlist.scrollLane, EVENTUALLY).toBeGreaterThan(0);
  });
});
