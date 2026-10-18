/**
 * Getting things into the clip launcher's slots from other places (headless Chrome, the real React shell, test
 * services with the fake engine): a clip dragged out of the playlist with the pointer (the playlist hands the drag
 * over, it uses no HTML drag-and-drop), audio files dropped from the computer, and the pad page over a grid bigger
 * than 8 × 8. Each drop is one undo step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { launcherFixture } from '@core/launcher/test-project';
import { encodeWav } from '@core/io/wav';
import { newId } from '@core/model/ids';
import type { AudioClip, Clip, ClipId, LaneId, PatternClip } from '@core/model/types';
import { ensureCapacity } from '@core/ops/launcher';
import { addClips, removeClips } from '@core/ops/playlist';
import { clipsSorted } from '@core/query/playlist';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const BAR = 3840;
const BAR_PX = 96; // pxPerTick 0.025
const LANE_H = 36;
const until = async (ok: () => boolean, ms = 8000) => {
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

describe('filling the clip launcher from the playlist, files and pads (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let lanes: LaneId[];
  let grid: HTMLElement;
  let f: ReturnType<typeof launcherFixture>;
  const clips = (): Clip[] => clipsSorted(s.doc.getState().project.playlist.clips) as Clip[];
  const win = () => host.querySelector<HTMLElement>('[data-window-type="launcher"]')!;
  const cell = (track: number, scene: number) => win().querySelector<HTMLElement>(`[data-slot][data-ti="${track}"][data-si="${scene}"]`)!;
  const slotAt = (track: number, scene: number) => {
    const l = s.doc.getState().project.launcher;
    return l?.tracks[l.trackOrder[track]!]?.slots[l.sceneOrder[scene]!];
  };
  const centre = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const pointer = (type: string, at: { x: number; y: number }, init: PointerEventInit = {}) =>
    grid.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: at.x,
        clientY: at.y,
        ...init,
      }),
    );
  /** A spot in the playlist grid: `fraction` of the way through bar `bar` (1-based) on track `lane` (0-based). */
  const spot = (bar: number, lane: number) => {
    const r = grid.getBoundingClientRect();
    return { x: r.left + (bar - 1 + 0.5) * BAR_PX, y: r.top + lane * LANE_H + LANE_H / 2 };
  };
  const steps = () => s.history.steps().done.length;

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    f = launcherFixture();
    const project = { ...f.project };
    delete (project as { launcher?: unknown }).launcher;
    s = createTestServices({ project });
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.editor.getState().setPlaylist({ tool: 'select', snap: 'bar', pxPerTick: 0.025, laneHeight: LANE_H, scrollTick: 0, scrollLane: 0 });
    lanes = s.doc.getState().project.playlist.laneOrder as LaneId[];
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'playlist');
    openWindow(s, 'launcher');
    // Side by side: the playlist on the left, the launcher on the right.
    s.view.getState().setRect('playlist', { x: 0, y: 0, w: 620, h: 360 });
    s.view.getState().setRect('launcher', { x: 640, y: 20, w: 620, h: 700 });
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="playlist"] div[data-hint^="Select:"], [data-window-type="playlist"] div[data-hint^="Draw:"]') && !!win() && win().querySelectorAll('[data-slot]').length === 64);
    grid = host.querySelector<HTMLElement>('[data-window-type="playlist"] div[data-hint^="Select:"], [data-window-type="playlist"] div[data-hint^="Draw:"]')!;
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  const seed = () => {
    const pattern: PatternClip = { kind: 'pattern', id: newId.clip(), laneId: lanes[0] as LaneId, start: 0, length: BAR, patternId: f.patterns[0]!, offset: 0 };
    const audio: AudioClip = { kind: 'audio', id: newId.clip(), laneId: lanes[1] as LaneId, start: BAR, length: BAR, channelId: f.audioId, offsetSec: 0.25 };
    s.history.transact('seed', (d) => addClips(d, [pattern, audio]));
    return { pattern, audio };
  };
  const clear = async () => {
    const ids = clips().map((c) => c.id);
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids as ClipId[]));
    s.editor.getState().selectClips([]);
    await frames(2);
  };

  it('a clip dragged out of the playlist and released over a slot goes in the slot: one undo step, the playlist unchanged', async () => {
    const { pattern } = seed();
    await frames(2);
    const before = steps();
    const target = cell(2, 1);
    pointer('pointerdown', spot(1, 0));
    pointer('pointermove', spot(1, 0));
    // Over the launcher: the slot is marked as the target, the clip does not move.
    pointer('pointermove', centre(target));
    expect(target.hasAttribute('data-clip-drop-over')).toBe(true);
    expect(clips().find((c) => c.id === pattern.id)).toMatchObject({ start: 0, laneId: lanes[0] });
    pointer('pointermove', centre(cell(3, 1)));
    expect(target.hasAttribute('data-clip-drop-over')).toBe(false);
    expect(cell(3, 1).hasAttribute('data-clip-drop-over')).toBe(true);
    pointer('pointermove', centre(target));
    pointer('pointerup', centre(target));
    expect(document.querySelector('[data-clip-drop-over]')).toBeNull();
    await until(() => !!slotAt(2, 1));
    expect(slotAt(2, 1)?.content).toEqual({ kind: 'pattern', patternId: f.patterns[0] });
    expect(steps()).toBe(before + 1);
    // The playlist clip stayed where it was (it was not moved by the drag).
    expect(clips().find((c) => c.id === pattern.id)).toMatchObject({ start: 0, laneId: lanes[0] });
    expect(cell(2, 1).textContent).toContain('Pattern A');
    await s.history.undo();
    await until(() => !slotAt(2, 1));
    expect(steps()).toBe(before);
    await clear();
  });

  it('several selected clips fill the slots below, an audio clip keeps its trim, automation clips are left out', async () => {
    const { pattern, audio } = seed();
    s.editor.getState().selectClips([pattern.id, audio.id]);
    await frames(2);
    const before = steps();
    pointer('pointerdown', spot(1, 0));
    pointer('pointermove', centre(cell(0, 0)));
    pointer('pointerup', centre(cell(3, 3)));
    await until(() => !!slotAt(3, 3));
    // Time order: the pattern clip (bar 1) first, the audio clip (bar 2) below it.
    expect(slotAt(3, 3)?.content).toMatchObject({ kind: 'pattern' });
    expect(slotAt(3, 4)?.content).toMatchObject({ kind: 'audio', channelId: f.audioId, offsetSec: 0.25 });
    expect(steps()).toBe(before + 1);
    await s.history.undo();
    await until(() => !slotAt(3, 3) && !slotAt(3, 4));
    await clear();
  });

  it('a drag that ends over the playlist still moves the clip (the hand-off only happens over a launcher slot)', async () => {
    const { pattern } = seed();
    await frames(2);
    pointer('pointerdown', spot(1, 0));
    pointer('pointermove', centre(cell(0, 0)));
    expect(cell(0, 0).hasAttribute('data-clip-drop-over')).toBe(true);
    // Back over the playlist, two bars on: the move carries on.
    pointer('pointermove', spot(3, 0));
    expect(document.querySelector('[data-clip-drop-over]')).toBeNull();
    pointer('pointerup', spot(3, 0));
    expect(clips().find((c) => c.id === pattern.id)).toMatchObject({ start: 2 * BAR, laneId: lanes[0] });
    expect(slotAt(0, 0)).toBeUndefined();
    await clear();
  });

  it('an audio file dropped from the computer is imported into a new audio channel and put in the slot: one undo step', async () => {
    const tone = new Float32Array(24000).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    const bytes = encodeWav([tone, tone.slice()], 48000, { bitDepth: 16 });
    const file = new File([bytes as unknown as BlobPart], 'Dropped loop.wav', { type: 'audio/wav' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const channels = Object.keys(s.doc.getState().project.channels).length;
    const before = steps();
    const target = cell(5, 5);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await until(() => !!slotAt(5, 5), 15000);
    const slot = slotAt(5, 5)!;
    expect(slot.content.kind).toBe('audio');
    const p = s.doc.getState().project;
    expect(Object.keys(p.channels)).toHaveLength(channels + 1);
    if (slot.content.kind !== 'audio') throw new Error('not audio');
    const ch = p.channels[slot.content.channelId]!;
    expect(ch).toMatchObject({ kind: 'audioClip', name: 'Dropped loop' });
    // A pass is the sound's length at the song's tempo: half a second.
    expect(slot.content.length).toBe(Math.round((0.5 * p.transport.bpm * 960) / 60));
    expect(p.samples[(ch as { sampleId: string }).sampleId as keyof typeof p.samples]?.source).toMatchObject({ kind: 'embedded', ext: 'wav' });
    expect(steps()).toBe(before + 1);
    await s.history.undo();
    await until(() => !slotAt(5, 5));
    expect(Object.keys(s.doc.getState().project.channels)).toHaveLength(channels);
    // A file that is not audio is left to the window: nothing happens.
    const junk = new DataTransfer();
    junk.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: junk });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a grid bigger than 8 × 8 shows the pad page, dims the rest, and the arrows move it', async () => {
    expect(win().querySelector('[aria-label="Pad page"]')).toBeNull();
    s.history.transact('grow', (d) => void ensureCapacity(d, 10, 9));
    await until(() => !!win().querySelector('[aria-label="Pad page"]'));
    expect(win().querySelector('[aria-label="Pad page"]')!.textContent).toContain('Pads 1,1 of 2×2');
    // Page (0,0): the slots of tracks 1–8 and scenes 1–8 are lit, the ninth track and scene are dimmed.
    expect(cell(0, 0).hasAttribute('data-off-page')).toBe(false);
    expect(cell(8, 0).hasAttribute('data-off-page')).toBe(true);
    expect(cell(0, 8).hasAttribute('data-off-page')).toBe(true);
    const right = win().querySelector<HTMLButtonElement>('[aria-label="Pad page right"]')!;
    await userEvent.click(right);
    await until(() => s.launcher.padPage().track === 1);
    expect(win().querySelector('[aria-label="Pad page"]')!.textContent).toContain('Pads 2,1 of 2×2');
    expect(cell(0, 0).hasAttribute('data-off-page')).toBe(true);
    expect(cell(8, 0).hasAttribute('data-off-page')).toBe(false);
    expect(win().querySelector<HTMLButtonElement>('[aria-label="Pad page right"]')!.disabled).toBe(true);
    // A slot's learn target is its pad on its page: the first pad of the second page is pad 1.
    expect(cell(8, 0).dataset.djTarget).toBe('launch.slot:1:1');
    // The commands do the same (and are in the action search and the AI's catalog).
    await s.commands.run('launcher.pageLeft');
    expect(s.launcher.padPage().track).toBe(0);
    await s.commands.run('launcher.pageDown');
    expect(s.launcher.padPage().scene).toBe(1);
    await s.commands.run('launcher.pageUp');
    expect(s.launcher.padPage().scene).toBe(0);
  });
});
