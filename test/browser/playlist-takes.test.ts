/**
 * Takes in the playlist (headless Chrome, the real React shell, test services with the fake engine): a recording's
 * takes fold under their comp track and open with the ▸ in its header; the Comp tool (and Alt-drag with any tool)
 * swipes across a take to use that part, one undo step each; the punch range is set on the ruler and cleared again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { tempoMapOf } from '@core/automation/tempo';
import type { AudioClip, AudioClipChannel, Clip, SampleId } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addTakeGroup, compSegmentsOf, newTakeGroup } from '@core/ops/comp';
import { clipsSorted } from '@core/query/playlist';
import { takeGroups } from '@core/query/takes';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { HEADER_WIDTH, FOLD_ZONE, LISTEN_ZONE } from '@ui/features/playlist/layout';
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

describe('takes in the playlist (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let grid: HTMLElement;
  let headers: HTMLElement;
  let ruler: HTMLElement;
  let group = '';
  const comp = () => compSegmentsOf(takeGroups(s.doc.getState().project)[0]!).map((x) => [x.take, x.from / BAR + 1, x.to / BAR + 1]);
  const spot = (bar: number, row: number, fraction = 0.5) => ({ x: (bar - 1 + fraction) * BAR_PX, y: row * LANE_H + LANE_H / 2 });
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

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar', pxPerTick: 0.025, laneHeight: LANE_H, scrollTick: 0, scrollLane: 0 });
    s.view.getState().setCurrentPattern(s.doc.getState().project.patternOrder[0]!);
    // A recording of three takes of bars 5–8 (the newest, take 3, plays).
    group = newTakeGroup();
    s.history.transact('Record 3 takes', (d) => {
      addSample(d, { id: 'smp' as SampleId, name: 'rec', source: { kind: 'builtin', generator: 'x', version: 1 } });
      const ch: AudioClipChannel = {
        kind: 'audioClip',
        id: 'ch_rec' as AudioClipChannel['id'],
        name: 'Recording 1',
        color: '#5f8fbf',
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        output: 'master' as never,
        sampleId: 'smp' as SampleId,
      };
      addChannel(d, ch);
      addTakeGroup(d, {
        group,
        name: 'Recording 1',
        channelId: ch.id,
        takes: [0, 1, 2].map((i) => ({ start: 4 * BAR, length: 4 * BAR, offsetSec: i * 8 })),
        audible: 2,
        first: 0,
        tempo: tempoMapOf(d as never, 'song'),
      });
    });
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
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    s.editor.getState().setPlaylist({ tool: 'draw', snap: 'bar' });
    s.editor.getState().setTakesOpen(group, true);
    s.editor.getState().selectClips([]);
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('the takes start open under the comp track; the ▸ in the comp track’s header folds and opens them', async () => {
    const takeAt = (row: number) => {
      fire(grid, 'pointerdown', spot(6, row));
      fire(grid, 'pointerup', spot(6, row));
      return s.editor.getState().clipSelection.map((id) => s.doc.getState().project.playlist.clips[id] as AudioClip);
    };
    // Row 0 is the comp track, rows 1–3 the takes (newest first).
    expect(takeAt(0)[0]?.take).toMatchObject({ comp: true, index: 2 });
    expect(takeAt(1)[0]?.take).toMatchObject({ index: 2 });
    expect(takeAt(3)[0]?.take).toMatchObject({ index: 0 });
    // Fold: a click on the toggle at the right end of the header.
    const before = s.doc.getState().project;
    fire(headers, 'pointerdown', { x: HEADER_WIDTH - FOLD_ZONE / 2, y: LANE_H / 2 });
    expect(s.editor.getState().openTakes).toEqual([]);
    await frames(2);
    // Folded: the rows under the comp track are the other tracks, so row 1 holds no take.
    s.editor.getState().selectClips([]);
    expect(takeAt(1)).toEqual([]);
    // Opening it again.
    fire(headers, 'pointerdown', { x: HEADER_WIDTH - FOLD_ZONE / 2, y: LANE_H / 2 });
    expect(s.editor.getState().openTakes).toEqual([group]);
    // Folding is view state: no undo step.
    expect(s.doc.getState().project).toBe(before);
    await frames(2);
  });

  it('the Comp tool swipes across a take: the comp track plays that part, one undo step', async () => {
    s.editor.getState().setPlaylist({ tool: 'comp' });
    expect(comp()).toEqual([[2, 5, 9]]);
    const before = s.doc.getState().project;
    // Take 1 is on row 3: swipe bars 6 to 8 (the grid snaps to bars).
    drag(grid, spot(6, 3, 0.05), spot(7, 3, 0.95));
    expect(comp()).toEqual([[2, 5, 6], [0, 6, 8], [2, 8, 9]]);
    expect(s.history.status().undoLabel).toBe('Use take 1 for part of the comp');
    // The comp lane is plain audio clips: the three of them, crossfaded at the borders.
    const g = takeGroups(s.doc.getState().project)[0]!;
    expect(g.comp).toHaveLength(3);
    expect(g.comp.every((c) => !c.muted)).toBe(true);
    // One undo step puts the comp lane back exactly.
    await s.history.undo();
    expect(comp()).toEqual([[2, 5, 9]]);
    expect(s.doc.getState().project).toEqual(before);
  });

  it('Alt-drag swipes with any tool; a plain click on a take with the Comp tool only selects it', async () => {
    const before = s.doc.getState().project;
    drag(grid, spot(5, 2, 0.05), spot(5, 2, 0.95), { altKey: true });
    expect(comp()).toEqual([[1, 5, 6], [2, 6, 9]]);
    await s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    s.editor.getState().setPlaylist({ tool: 'comp' });
    fire(grid, 'pointerdown', spot(6, 2));
    fire(grid, 'pointerup', spot(6, 2));
    expect(s.doc.getState().project).toEqual(before);
    expect(s.editor.getState().clipSelection).toHaveLength(1);
  });

  it('Next and Previous take swap the part under the clip; the commands take a clip', async () => {
    const g = () => takeGroups(s.doc.getState().project)[0]!;
    const takeClip = g().takes[0]!.clips[0]!;
    // Select the first take's clip: next take swaps the comp over the clip's span (the whole 4 bars) for the next one.
    s.editor.getState().selectClips([takeClip.id]);
    const before = s.doc.getState().project;
    await s.commands.run('comp.nextTake');
    expect(comp()).toEqual([[0, 5, 9]]); // the comp played take 3; next goes round to take 1
    await s.commands.run('comp.nextTake', { clip: takeClip.id });
    expect(comp()).toEqual([[1, 5, 9]]);
    await s.commands.run('comp.previousTake', { clip: takeClip.id });
    expect(comp()).toEqual([[0, 5, 9]]);
    await s.commands.run('comp.useTake', { take: 3, from_bar: 7, to_bar: 7 });
    expect(comp()).toEqual([[0, 5, 7], [2, 7, 8], [0, 8, 9]]);
    for (let i = 0; i < 4; i++) await s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    // Flatten: the take lanes go, the comp stays as plain clips; undo brings it all back.
    await s.commands.run('comp.flatten', { group });
    expect(takeGroups(s.doc.getState().project)).toHaveLength(0);
    expect((clipsSorted(s.doc.getState().project.playlist.clips) as Clip[]).filter((c) => c.kind === 'audio')).toHaveLength(1);
    await s.history.undo();
    expect(takeGroups(s.doc.getState().project)[0]!.takes).toHaveLength(3);
    s.editor.getState().setTakesOpen(group, true);
  });

  it('the speaker on a take track listens to that take alone: a click switches it on and off, a hold listens only while pressed', async () => {
    const speaker = { x: HEADER_WIDTH - LISTEN_ZONE / 2 - 3, y: LANE_H + LANE_H / 2 };
    const heard = () => s.editor.getState().auditionTake;
    const newest = takeGroups(s.doc.getState().project)[0]!.takes.find((t) => t.index === 2)!.clips[0]!.id;
    // A quick click switches it on and leaves it on; the next click switches it off.
    fire(headers, 'pointerdown', speaker);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(heard()).toBe(newest);
    fire(headers, 'pointerdown', speaker);
    expect(heard()).toBeNull();
    // Held down it listens only while it is pressed.
    fire(headers, 'pointerdown', speaker);
    expect(heard()).toBe(newest);
    await new Promise((r) => setTimeout(r, 450));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(heard()).toBeNull();
  });

  it('Alt-drag on the ruler sets the punch range (not the loop); Alt-double-click clears it', async () => {
    expect(s.view.getState().punch).toBeNull();
    // The ruler snaps to a quarter bar: bar 3 to bar 5.
    drag(ruler, { x: 2 * BAR_PX + 1, y: 8 }, { x: 4 * BAR_PX + 1, y: 8 }, { altKey: true });
    expect(s.view.getState().punch).toEqual({ start: 2 * BAR, end: 4 * BAR });
    expect(s.view.getState().loop).toBeNull();
    ruler.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, altKey: true, clientX: ruler.getBoundingClientRect().left + 3 * BAR_PX, clientY: ruler.getBoundingClientRect().top + 8 }));
    expect(s.view.getState().punch).toBeNull();
    // The commands do the same from a menu or the action search.
    await s.commands.run('record.punchRange', { from_bar: 9, to_bar: 12 });
    expect(s.view.getState().punch).toEqual({ start: 8 * BAR, end: 12 * BAR });
    await s.commands.run('record.clearPunch');
    expect(s.view.getState().punch).toBeNull();
  });
});
