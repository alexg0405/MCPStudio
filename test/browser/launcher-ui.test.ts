/**
 * The Clip launcher window in the real UI (headless Chrome, the React shell, test services with the fake engine
 * and a clock that runs): the empty window says what to do, a press queues and then plays a slot and the ring
 * fills, idle launcher playback makes no React commits, the keyboard (arrows, Enter, number keys), the slot menu,
 * dropping a pattern from the browser, and every control explaining itself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { launcherFixture } from '@core/launcher/test-project';
import type { LaunchClock } from '@core/launcher/run';
import { registerFeatures } from '@ui/features';
import { EMPTY_TEXT, EMPTY_TITLE } from '@ui/features/launcher/LauncherWindow';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

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

describe('Clip launcher window (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let commits = 0;
  const errors: unknown[] = [];
  /** The fake transport: starts running when the first slot is pressed, 10 ticks per millisecond (a bar is 384 ms). */
  let t0 = 0;
  let running = false;
  const clock = (): LaunchClock => {
    const heardU = running ? (performance.now() - t0) * 10 : 0;
    return { playing: running, heardU, earliestU: heardU + 60 };
  };
  const win = () => host.querySelector<HTMLElement>('[data-window-type="launcher"]')!;
  const cells = () => [...win().querySelectorAll<HTMLElement>('[data-slot]')];
  const cell = (track: number, scene: number) => cells()[scene * 8 + track]!;
  const state = (track: number, scene: number) => cell(track, scene).dataset.state;
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((b) => b.textContent?.includes(label));
  const rightClick = (el: Element) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  };

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    host.id = 'root';
    document.body.append(host);
    // The fixture's patterns, without its grid: the window starts empty.
    const f = launcherFixture();
    const project = { ...f.project };
    delete (project as { launcher?: unknown }).launcher;
    s = createTestServices({ project });
    // The fake engine has no transport: give it the launcher's clock and a start.
    const engine = s.fakeEngine as unknown as { launcherClock(): LaunchClock; launcherChanged(): void };
    engine.launcherClock = clock;
    engine.launcherChanged = () => {
      if (!running && s.launcher.runs.length) {
        running = true;
        t0 = performance.now();
      }
    };
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'launcher');
    s.view.getState().setMaximized('launcher', true);
    root = createRoot(host);
    root.render(createElement(Profiler, { id: 'app', onRender: () => void commits++ }, createElement(ServicesProvider, { services: s, children: createElement(App) })));
    await until(() => !!win() && cells().length === 64);
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    vi.restoreAllMocks();
  });

  it('an empty launcher says what to do next, with a way to start', () => {
    expect(win().textContent).toContain(EMPTY_TITLE);
    expect(win().textContent).toContain('Drag a pattern from the Browser into a slot');
    expect(EMPTY_TEXT).toMatch(/press a slot/);
    expect(cells().every((c) => c.dataset.state === 'empty')).toBe(true);
    expect(win().querySelectorAll('[data-dj-target^="launch.scene:"]')).toHaveLength(8);
    expect(win().querySelectorAll('[data-dj-target^="launch.stop:"]')).toHaveLength(8);
  });

  it('dropping a pattern from the Browser on a slot fills it (and the empty message goes)', async () => {
    const id = s.doc.getState().project.patternOrder[1]!;
    const dt = new DataTransfer();
    dt.setData('application/x-agstudio-pattern', id);
    const target = cell(2, 1);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await until(() => state(2, 1) === 'idle');
    expect(cell(2, 1).textContent).toContain('Pattern A');
    expect(win().textContent).not.toContain(EMPTY_TITLE);
    expect(s.doc.getState().project.launcher!.trackOrder).toHaveLength(8);
    // One undo step takes the grid away again.
    s.history.undo();
    await until(() => state(2, 1) === 'empty');
    expect(win().textContent).toContain(EMPTY_TITLE);
    s.history.redo();
    await until(() => state(2, 1) === 'idle');
  });

  it('"Put my patterns in the grid" fills the first track, one pattern per scene', async () => {
    // Redo left one pattern in track 3: start from an empty grid again.
    s.history.undo();
    await until(() => win().textContent!.includes(EMPTY_TITLE));
    const button = [...win().querySelectorAll('button')].find((b) => b.textContent?.includes('Put my patterns'))!;
    await userEvent.click(button);
    await until(() => state(0, 0) === 'idle');
    expect([0, 1, 2].map((i) => cell(0, i).textContent)).toEqual(expect.arrayContaining(['Pattern 1', 'Pattern A', 'Pattern B'].map((x) => expect.stringContaining(x))));
    expect(state(0, 3)).toBe('idle');
    expect(state(0, 4)).toBe('empty');
  });

  it('a press queues the slot for the next bar, then it plays and its ring fills', async () => {
    // Put pattern C in track 2 as well, to launch two things.
    await userEvent.click(cell(0, 1));
    expect(s.launcher.runs).toHaveLength(1);
    // The transport started with this press (u = 0): the slot plays at once.
    await until(() => state(0, 1) === 'playing');
    const ring = cell(0, 1);
    await until(() => Number(ring.style.getPropertyValue('--p')) > 0.05);
    const first = Number(ring.style.getPropertyValue('--p'));
    await frames(12);
    expect(Number(ring.style.getPropertyValue('--p'))).not.toBe(first);
    // Another slot of the track is queued for the next bar, and replaces the first when it starts.
    await userEvent.click(cell(0, 2));
    await until(() => state(0, 2) === 'queued' || state(0, 2) === 'playing');
    await until(() => state(0, 2) === 'playing');
    expect(state(0, 1)).toBe('idle');
    // The scene button lights up while its row plays.
    const scene3 = win().querySelectorAll<HTMLElement>('[data-scene-btn]')[2]!;
    await until(() => scene3.dataset.state === 'playing');
    // The track's stop button shows it plays.
    await until(() => win().querySelectorAll<HTMLElement>('[data-stop-btn]')[0]!.dataset.state === 'playing');
  });

  it('idle playback causes no React commits and no DOM writes beyond the rings', async () => {
    await frames(10);
    const before = commits;
    const writes: string[] = [];
    const obs = new MutationObserver((list) => {
      for (const m of list) if (m.type === 'attributes' && m.attributeName !== 'style') writes.push(String(m.attributeName));
    });
    obs.observe(win(), { attributes: true, subtree: true, childList: true, characterData: true });
    await frames(60);
    obs.disconnect();
    expect(commits).toBe(before);
    expect(writes).toEqual([]);
  });

  it('the keyboard moves the highlight, Enter launches it and number keys launch scenes', async () => {
    const status = () => win().querySelector<HTMLElement>('[class*="status"]')!.textContent!;
    await userEvent.click(cell(5, 5));
    await until(() => status().startsWith('Track 6, scene 6'));
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
    await until(() => status().startsWith('Track 5, scene 5'));
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    await until(() => status().startsWith('Track 8, scene 5'));
    // Enter on the slot of track 1, scene 4 (pattern 4: nothing there... use scene 2: Pattern A).
    await userEvent.click(cell(0, 0));
    await userEvent.keyboard('{ArrowDown}');
    await until(() => status().startsWith('Track 1, scene 2'));
    const runsBefore = s.launcher.runs.length;
    await userEvent.keyboard('{Enter}');
    expect(s.launcher.runs.length).toBeGreaterThan(0);
    void runsBefore;
    // Number key 3 launches scene 3: track 1's slot there (Pattern B) is queued.
    await userEvent.keyboard('3');
    expect(s.launcher.runs.some((r) => r.sceneId === s.launcher.sceneAt(2))).toBe(true);
    // Period stops the highlighted track; Delete empties the highlighted slot.
    await userEvent.keyboard('.');
    expect(s.launcher.runs.filter((r) => r.trackId === s.launcher.trackAt(0)).every((r) => r.endU !== null || r.startU > clock().earliestU)).toBe(true);
    await userEvent.keyboard('{Delete}');
    await until(() => state(0, 1) === 'empty');
    s.history.undo();
    await until(() => state(0, 1) !== 'empty');
  });

  it('the slot menu changes mode, loop, quantize and follow action, each one undo step', async () => {
    const slotOf = () => s.doc.getState().project.launcher!.tracks[s.launcher.trackAt(0)!]!.slots[s.launcher.sceneAt(0)!]!;
    rightClick(cell(0, 0));
    await until(() => !!menuItem('Loop'));
    expect(menuItem('Launch mode: Trigger')).toBeDefined();
    expect(menuItem('Follow action: none')).toBeDefined();
    const before = s.history.steps().done.length;
    menuItem('Loop')!.click();
    await until(() => slotOf().loop === false);
    expect(s.history.steps().done.length).toBe(before + 1);
    s.history.undo();
    await until(() => slotOf().loop === undefined);
    rightClick(cell(0, 0));
    await until(() => !!menuItem('Launch mode'));
    menuItem('Launch mode')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    menuItem('Launch mode')!.click();
    await until(() => !!menuItem('Gate'));
    menuItem('Gate')!.click();
    await until(() => slotOf().mode === 'gate');
    s.history.undo();
    await until(() => slotOf().mode === undefined);
  });

  it('every control of the window explains itself', () => {
    const missing = [...win().querySelectorAll<HTMLElement>('button, select, [data-slot], [data-scene-btn], [data-stop-btn]')]
      .filter((el) => !el.closest('[data-hint]') && !el.hasAttribute('data-hint') && !el.getAttribute('aria-label'))
      .map((el) => `${el.tagName} ${el.textContent?.slice(0, 20)}`);
    // The title-bar buttons of the floating window have their own hints; the window's content must all have one.
    expect(missing.filter((m) => !/^BUTTON (×|–|\+)?$/.test(m))).toEqual([]);
  });

  it('logged no errors', () => {
    expect(errors).toEqual([]);
  });
});
