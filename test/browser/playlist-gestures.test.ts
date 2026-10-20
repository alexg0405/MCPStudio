/**
 * Playlist gestures that the other playlist tests leave out (headless Chrome, the real React shell, test services with
 * the fake engine): the track headers (mute, solo, rename), the ruler (song position, loop, markers and their menus),
 * the gain and fade handles of an audio clip, dropping a pattern or a sound on the grid, double-click, the Ask Studio
 * pill, and the view (wheel zoom and scroll, middle-button pan, the scrollbar thumb).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addAudioClip } from '@app/actions/samples';
import { kitSampleRef } from '@app/default-project';
import { addMarkerAt } from '@app/actions/markers';
import { newId } from '@core/model/ids';
import type { AudioClip, Clip, ClipId, LaneId, MarkerId, PatternId } from '@core/model/types';
import { addClips, removeClips } from '@core/ops/playlist';
import { clipsSorted } from '@core/query/playlist';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { clipBox } from '@ui/features/playlist/clip-geometry';
import { Viewport } from '@ui/timeline/viewport';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY } from '../helpers/wait';

const BAR = 3840;
const BAR_PX = 96; // pxPerTick 0.025
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('playlist gestures (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let lanes: LaneId[];
  let pattern: PatternId;
  let grid: HTMLElement;
  let headers: HTMLElement;
  let ruler: HTMLElement;
  let thumb: HTMLElement;
  const clips = (): Clip[] => clipsSorted(s.doc.getState().project.playlist.clips) as Clip[];
  const cursor = () => s.history.status().cursor;
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
    for (let i = 1; i <= 5; i++) fire(el, 'pointermove', { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 }, init);
    fire(el, 'pointerup', to, init);
  };
  const doubleClick = (el: HTMLElement, p: { x: number; y: number }, init: MouseEventInit = {}) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: r.left + p.x, clientY: r.top + p.y, ...init }));
  };
  const wheel = (el: HTMLElement, p: { x: number; y: number }, init: WheelEventInit) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + p.x, clientY: r.top + p.y, ...init }));
  };
  const key = (el: HTMLElement | Window, name: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  const lane = (i: number) => s.doc.getState().project.playlist.lanes[lanes[i] as LaneId]!;
  const markerNameField = () => host.querySelector<HTMLInputElement>('input[aria-label="Marker name"]')!;
  const laneNameField = () => host.querySelector<HTMLInputElement>('[data-window-type="playlist"] input:not([aria-label])')!;
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
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="playlist"] div[data-hint^="Draw:"]'));
    grid = host.querySelector<HTMLElement>('[data-window-type="playlist"] div[data-hint^="Draw:"]')!;
    headers = host.querySelector<HTMLElement>('[data-window-type="playlist"] canvas[data-hint^="Tracks:"]')!;
    ruler = host.querySelector<HTMLElement>('[data-window-type="playlist"] canvas[data-hint^="Drag to set a loop region"]')!;
    thumb = host.querySelector<HTMLElement>('[data-window-type="playlist"] [class*="hthumb"]')!;
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    const ids = clips().map((c) => c.id);
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids as ClipId[]));
    s.editor.getState().selectClips([]);
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar' });
    s.view.getState().setLoop(null);
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  describe('track headers', () => {
    it('a click on the light mutes the track and a right-click solos it (one undo step each)', async () => {
      const light = { x: 14, y: LANE_H + LANE_H / 2 };
      fire(headers, 'pointerdown', light);
      expect(lane(1).muted).toBe(true);
      expect(s.history.status().undoLabel).toBe('Mute track');
      fire(headers, 'pointerdown', light);
      expect(lane(1).muted).toBeFalsy();
      expect(s.history.status().undoLabel).toBe('Unmute track');
      fire(headers, 'pointerdown', light, { button: 2, buttons: 2 });
      expect(lane(1).solo).toBe(true);
      expect(s.history.status().undoLabel).toBe('Solo track');
      await s.history.undo();
      await s.history.undo();
      await s.history.undo();
      expect(lane(1).solo).toBeFalsy();
    });

    it('a double-click on a name opens the rename field: Enter renames (one step), Esc keeps the name', async () => {
      const name = lane(2).name;
      const at = { x: 60, y: 2 * LANE_H + LANE_H / 2 };
      doubleClick(headers, at);
      const field = laneNameField();
      expect(field.style.display).toBe('block');
      expect(field.value).toBe(name);
      field.value = 'Bassline';
      key(field, 'Enter');
      expect(lane(2).name).toBe('Bassline');
      expect(s.history.status().undoLabel).toBe('Rename track');
      doubleClick(headers, at);
      laneNameField().value = 'Nope';
      key(laneNameField(), 'Escape');
      expect(lane(2).name).toBe('Bassline');
      expect(laneNameField().style.display).toBe('none');
      await s.history.undo();
      expect(lane(2).name).toBe(name);
    });

    it('a right-click on a name opens the track menu', async () => {
      fire(headers, 'pointerdown', { x: 60, y: LANE_H / 2 }, { button: 2, buttons: 2 });
      await until(() => !!document.querySelector('[role="menu"]'));
      closeContextMenu();
    });
  });

  describe('ruler and markers', () => {
    it('a click sets the song position (on a quarter bar); a drag sets the loop; a double-click clears it', async () => {
      fire(ruler, 'pointerdown', { x: 3 * BAR_PX + 1, y: 8 });
      fire(ruler, 'pointerup', { x: 3 * BAR_PX + 1, y: 8 });
      expect(s.view.getState().songStart).toBe(3 * BAR);
      drag(ruler, { x: 2 * BAR_PX + 1, y: 8 }, { x: 5 * BAR_PX + 1, y: 8 });
      expect(s.view.getState().loop).toEqual({ start: 2 * BAR, end: 5 * BAR });
      doubleClick(ruler, { x: 6 * BAR_PX, y: 8 });
      expect(s.view.getState().loop).toBeNull();
    });

    it('a right-click on an empty spot of the ruler opens the ruler menu; on a marker, the marker menu', async () => {
      fire(ruler, 'pointerdown', { x: 8 * BAR_PX, y: 8 }, { button: 2, buttons: 2 });
      await until(() => !!document.querySelector('[role="menu"]'));
      expect(document.body.textContent).toContain('Add marker here');
      closeContextMenu();
      const id = addMarkerAt(s, 4 * BAR, 'Verse');
      await frames(3);
      fire(ruler, 'pointerdown', { x: 4 * BAR_PX + 10, y: 26 }, { button: 2, buttons: 2 });
      await until(() => !!document.querySelector('[role="menu"]'));
      expect(document.body.textContent).toContain('Play this section');
      closeContextMenu();
      await s.history.undo();
      expect(s.doc.getState().project.playlist.markers[id]).toBeUndefined();
    });

    it('a click on a marker jumps to it; a drag moves it (one undo step, snapped to the grid)', async () => {
      const id = addMarkerAt(s, 4 * BAR, 'Verse');
      await frames(3);
      const flag = { x: 4 * BAR_PX + 10, y: 26 };
      fire(ruler, 'pointerdown', flag);
      fire(ruler, 'pointerup', flag);
      expect(s.view.getState().songStart).toBe(4 * BAR);
      drag(ruler, flag, { x: flag.x + 2 * BAR_PX, y: 26 });
      expect(s.doc.getState().project.playlist.markers[id]?.tick).toBe(6 * BAR);
      expect(s.history.status().undoLabel).toBe('Move marker ‘Verse’');
      await s.history.undo();
      expect(s.doc.getState().project.playlist.markers[id]?.tick).toBe(4 * BAR);
      await s.history.undo();
      expect(s.doc.getState().project.playlist.markers[id]).toBeUndefined();
    });

    it('Esc during a marker drag drops it; a double-click renames the marker on the ruler', async () => {
      const id = addMarkerAt(s, 4 * BAR, 'Verse');
      await frames(3);
      const flag = { x: 4 * BAR_PX + 10, y: 26 };
      const before = cursor();
      fire(ruler, 'pointerdown', flag);
      fire(ruler, 'pointermove', { x: flag.x + 96, y: 26 });
      key(window, 'Escape');
      fire(ruler, 'pointerup', { x: flag.x + 96, y: 26 });
      expect(s.doc.getState().project.playlist.markers[id]?.tick).toBe(4 * BAR);
      expect(cursor()).toBe(before);
      doubleClick(ruler, flag);
      const field = markerNameField();
      expect(field.style.display).toBe('block');
      expect(field.value).toBe('Verse');
      field.value = 'Chorus';
      key(field, 'Enter');
      expect(s.doc.getState().project.playlist.markers[id]?.name).toBe('Chorus');
      await s.history.undo();
      await s.history.undo();
    });

    it('the request to name a marker (Alt+T, the menu) puts the field on its flag', async () => {
      const id: MarkerId = addMarkerAt(s, 2 * BAR, 'New');
      const { markerRename } = await import('@ui/features/playlist/markers');
      markerRename.setState({ id });
      await until(() => markerNameField().style.display === 'block');
      key(markerNameField(), 'Escape');
      expect(markerNameField().style.display).toBe('none');
      await s.history.undo();
    });
  });

  describe('audio clip handles', () => {
    /** A long audio clip from bar 2 on the first track, selected; its box in the grid. */
    const audioClip = () => {
      const ref = { ...kitSampleRef('kit/kick'), durationSec: 8 };
      const id = addAudioClip(s, ref, lanes[0] as LaneId, BAR);
      const clip = s.doc.getState().project.playlist.clips[id] as AudioClip;
      const vp = new Viewport(10, 0.001, 2);
      vp.pxPerTick = 0.025;
      vp.rowHeight = LANE_H;
      const box = clipBox(vp, 0, clip);
      return { clip, box, y: box.bodyY + 4.5 };
    };
    const current = (id: ClipId) => s.doc.getState().project.playlist.clips[id] as AudioClip;

    it('dragging the gain handle up raises the clip gain in one undo step; a double-click puts it back to 0 dB', async () => {
      const { clip, box, y } = audioClip();
      const handle = { x: box.x + box.w / 2, y };
      const before = cursor();
      drag(grid, handle, { x: handle.x, y: y - 20 });
      expect(current(clip.id).gain).toBeGreaterThan(1.5);
      expect(s.history.status().undoLabel).toBe('Clip gain');
      doubleClick(grid, handle);
      expect(current(clip.id).gain).toBeUndefined();
      expect(s.history.status().undoLabel).toBe('Clip gain 0 dB');
      await s.history.undo();
      await s.history.undo();
      expect(cursor()).toBe(before);
    });

    it('dragging the fade-in handle sets the fade; Esc drops a drag; a double-click removes the fade', async () => {
      const { clip, box, y } = audioClip();
      const handle = { x: box.x + 5, y };
      drag(grid, handle, { x: handle.x + 60, y });
      expect(current(clip.id).fadeIn).toBeGreaterThan(0.05);
      expect(s.history.status().undoLabel).toBe('Fade in');
      const before = cursor();
      doubleClick(grid, { x: box.x + 5 + 60, y });
      expect(current(clip.id).fadeIn).toBeUndefined();
      expect(s.history.status().undoLabel).toBe('Remove fade in');
      await s.history.undo();
      expect(cursor()).toBe(before);
      // Esc during a fade-out drag leaves the clip alone.
      const out = { x: box.x + box.w - 6, y };
      fire(grid, 'pointerdown', out);
      fire(grid, 'pointermove', { x: out.x - 50, y });
      key(window, 'Escape');
      fire(grid, 'pointerup', { x: out.x - 50, y });
      expect(current(clip.id).fadeOut).toBeUndefined();
      expect(cursor()).toBe(before);
    });
  });

  describe('clips', () => {
    it('a double-click on a pattern clip makes it the current pattern and opens the channel rack', async () => {
      const made = addPatternClip(3, 0);
      s.view.getState().hideWindow('channel-rack');
      doubleClick(grid, { x: 2.5 * BAR_PX, y: LANE_H / 2 });
      expect(s.view.getState().currentPatternId).toBe((made as Extract<Clip, { kind: 'pattern' }>).patternId);
      await until(() => Object.values(s.view.getState().windows).some((w) => w.type === 'channel-rack' && w.visible));
    });

    it('the ▾ in a clip’s title bar opens the clip menu and selects the clip', async () => {
      const made = addPatternClip(3, 0);
      s.editor.getState().selectClips([]);
      const at = { x: 2 * BAR_PX + 5, y: 5 };
      fire(grid, 'pointerdown', at);
      await until(() => !!document.querySelector('[role="menu"]'));
      expect(s.editor.getState().clipSelection).toEqual([made.id]);
      closeContextMenu();
    });

    it('dropping a pattern from the browser places it where it lands (one undo step); a kit sound makes an audio clip', async () => {
      const dropAt = { x: 5.2 * BAR_PX, y: 2 * LANE_H + 10 };
      const r = grid.getBoundingClientRect();
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      over.dataTransfer!.setData('application/x-agstudio-pattern', pattern);
      grid.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      const dt = new DataTransfer();
      dt.setData('application/x-agstudio-pattern', pattern);
      grid.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + dropAt.x, clientY: r.top + dropAt.y }));
      expect(clips()).toHaveLength(1);
      expect(clips()[0]).toMatchObject({ kind: 'pattern', start: 5 * BAR, laneId: lanes[2] });
      expect(s.history.status().undoLabel).toBe('Add clip');
      const sound = new DataTransfer();
      sound.setData('application/x-agstudio-sound', 'kit/kick');
      grid.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: sound, clientX: r.left + 8 * BAR_PX, clientY: r.top + LANE_H / 2 }));
      expect(clips().filter((c) => c.kind === 'audio')).toHaveLength(1);
      // Something else dragged over the grid is not accepted.
      const other = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      grid.dispatchEvent(other);
      expect(other.defaultPrevented).toBe(false);
    });

    it('the Ask Studio pill shows over the selected clip and says what it asks about', async () => {
      const made = addPatternClip(3, 1);
      const pill = host.querySelector<HTMLElement>('button[aria-label="Ask Studio about this part"]')!;
      s.editor.getState().selectClips([]);
      await frames(3);
      await expect.poll(() => pill.style.display, EVENTUALLY).toBe('none');
      s.editor.getState().selectClips([made.id]);
      await until(() => pill.style.display !== 'none');
      expect(pill.getAttribute('data-hint')).toContain('change this clip');
      expect(pill.getBoundingClientRect().width).toBeGreaterThan(0);
    });
  });

  // These change the view itself (its zoom and scroll), so they come last and undo their own change.
  describe('the view', () => {
    const saved = async () => {
      await sleep(400);
      return s.editor.getState().playlist;
    };

    it('Ctrl + wheel zooms the time axis, Alt + wheel the track height, a plain wheel scrolls', async () => {
      wheel(grid, { x: 0, y: 40 }, { deltaY: -100, ctrlKey: true });
      expect((await saved()).pxPerTick).toBeGreaterThan(0.025);
      wheel(grid, { x: 0, y: 40 }, { deltaY: 100, ctrlKey: true });
      expect((await saved()).pxPerTick).toBeCloseTo(0.025, 6);
      wheel(grid, { x: 20, y: 40 }, { deltaY: -100, altKey: true });
      expect((await saved()).laneHeight).toBeGreaterThan(LANE_H);
      wheel(grid, { x: 20, y: 40 }, { deltaY: 100, altKey: true });
      expect((await saved()).laneHeight).toBeCloseTo(LANE_H, 6);
      wheel(grid, { x: 20, y: 40 }, { deltaX: 300, deltaY: 0 });
      expect((await saved()).scrollTick).toBeCloseTo(300 / 0.025, 3);
      wheel(grid, { x: 20, y: 40 }, { deltaX: -300, deltaY: 0 });
      expect((await saved()).scrollTick).toBe(0);
      // Shift turns the vertical wheel into a sideways scroll.
      wheel(ruler, { x: 20, y: 8 }, { deltaY: 200, shiftKey: true });
      expect((await saved()).scrollTick).toBeCloseTo(200 / 0.025, 3);
      wheel(ruler, { x: 20, y: 8 }, { deltaY: -200, shiftKey: true });
      expect((await saved()).scrollTick).toBe(0);
    });

    it('a middle-button drag pans the view', async () => {
      const middle = { button: 1, buttons: 4 };
      fire(grid, 'pointerdown', { x: 400, y: 100 }, middle);
      fire(grid, 'pointermove', { x: 350, y: 100 }, middle);
      fire(grid, 'pointerup', { x: 350, y: 100 }, { button: 1 });
      expect((await saved()).scrollTick).toBeCloseTo(50 / 0.025, 3);
      fire(grid, 'pointerdown', { x: 350, y: 100 }, middle);
      fire(grid, 'pointermove', { x: 400, y: 100 }, middle);
      fire(grid, 'pointerup', { x: 400, y: 100 }, { button: 1 });
      expect((await saved()).scrollTick).toBe(0);
      expect(clips()).toHaveLength(0);
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
      thumb.dispatchEvent(event('pointerdown', 60));
      thumb.dispatchEvent(event('pointermove', 0));
      thumb.dispatchEvent(event('pointerup', 0));
      expect((await saved()).scrollTick).toBeLessThan(moved);
      wheel(grid, { x: 20, y: 40 }, { deltaX: -100000, deltaY: 0 });
      expect((await saved()).scrollTick).toBe(0);
    });
  });
});
