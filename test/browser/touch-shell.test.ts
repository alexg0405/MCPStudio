/**
 * The shell under real fingers (Chrome's touch input through DevTools, see `test/helpers/touch.ts`; headless Chrome, the
 * real React shell, test services with the fake engine): windows move and resize by their title bar and handles, the menus
 * and the action search work by tapping, a resting finger shows a control's hint, the touch layout turns on and off (and the
 * search button comes with it), the step sequencer paints along a finger, and the Keys panel plays one note per finger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import type { LiveEvent } from '@app/live-input';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { paletteStore } from '@ui/features/palette/Palette';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { installTouch, } from '@ui/touch';
import { installTouchLayout } from '@ui/touch/layout';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import '@ui/touch/touch.css';
import { centerOf, Fingers, insideOf, nextFrame, sleep, until } from '../helpers/touch';

const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await nextFrame();
};

describe('the shell with touch', { timeout: 90_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let stopTouch: () => void;
  let fingers: Fingers;
  const windowEl = (id: string) => host.querySelector<HTMLElement>(`[data-window-id="${id}"]`)!;
  /** Where the window is on the screen now. */
  const rectOf = (id: string) => {
    const box = windowEl(id).getBoundingClientRect();
    return { x: box.left, y: box.top, w: box.width, h: box.height };
  };
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((b) => b.textContent?.includes(label));
  const label = (menu: string) => host.querySelector<HTMLElement>(`[data-menu="${menu}"]`)!;

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    stopTouch = installTouch(s);
    openWindow(s, 'channel-rack');
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!windowEl('channel-rack'));
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    if (paletteStore.getState().open) paletteStore.setState({ open: false, query: '' });
    await fingers?.liftAll();
    fingers = new Fingers();
    s.prefs.getState().set({ touchLayout: 'off' });
    await frames(2);
  });

  afterAll(async () => {
    await fingers.liftAll();
    stopTouch();
    root.unmount();
    host.remove();
  });

  describe('windows', () => {
    it('drag by the title bar, and the window follows the finger (one move, kept inside the workspace)', async () => {
      const before = { ...rectOf('channel-rack') };
      const bar = windowEl('channel-rack').querySelector<HTMLElement>('[class*="titleBar"]')!;
      const at = insideOf(bar, 120, 10);
      await fingers.press(1, at);
      await fingers.drag(1, { x: at.x + 90, y: at.y + 70 });
      await fingers.lift(1);
      await frames(2);
      const after = rectOf('channel-rack');
      expect(after.x - before.x).toBeCloseTo(90, 0);
      expect(after.y - before.y).toBeCloseTo(70, 0);
      expect(after.w).toBe(before.w);
    });

    it('resize from the corner handle', async () => {
      const before = { ...rectOf('channel-rack') };
      const handle = windowEl('channel-rack').querySelector<HTMLElement>('[class*="h_se"]')!;
      const at = centerOf(handle);
      await fingers.press(1, at);
      await fingers.drag(1, { x: at.x + 70, y: at.y + 50 });
      await fingers.lift(1);
      await frames(2);
      const after = rectOf('channel-rack');
      expect(after.w - before.w).toBeCloseTo(70, 0);
      expect(after.h - before.h).toBeCloseTo(50, 0);
    });

    it('in the touch layout the resize handles reach well outside the window, and the title bar is at least 40 px tall', async () => {
      s.prefs.getState().set({ touchLayout: 'on' });
      await frames(2);
      const win = windowEl('channel-rack');
      const bar = win.querySelector<HTMLElement>('[class*="titleBar"]')!;
      expect(bar.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
      const handle = win.querySelector<HTMLElement>('[class*="h_se"]')!;
      expect(handle.getBoundingClientRect().width).toBeGreaterThanOrEqual(30);
      const before = { ...rectOf('channel-rack') };
      const box = win.getBoundingClientRect();
      // 9 px outside the corner: only the touch layout's handle is there.
      const outside = { x: box.right + 9, y: box.bottom + 9 };
      await fingers.press(1, outside);
      await fingers.drag(1, { x: outside.x + 40, y: outside.y + 30 });
      await fingers.lift(1);
      await frames(2);
      expect(rectOf('channel-rack').w - before.w).toBeCloseTo(40, 0);
    });

    it('two quick taps on the title bar maximize the window (a double-click)', async () => {
      const bar = windowEl('channel-rack').querySelector<HTMLElement>('[class*="titleBar"]')!;
      const at = insideOf(bar, 100, 10);
      await fingers.doubleTap(1, at);
      await until(() => !!s.view.getState().windows['channel-rack']!.maximized);
      s.view.getState().setMaximized('channel-rack', false);
    });
  });

  describe('menus and the action search', () => {
    it('a tap opens a menu and a tap on its row runs the command', async () => {
      await fingers.tap(1, centerOf(label('view')));
      await until(() => !!document.querySelector('[role="menu"]'));
      const row = menuItem('Touch layout')!;
      expect(row).toBeTruthy();
      await fingers.tap(1, centerOf(row));
      await until(() => s.prefs.getState().touchLayout === 'on');
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('a submenu opens by a tap on its row, and its rows can be tapped', async () => {
      await fingers.tap(1, centerOf(label('options')));
      await until(() => !!document.querySelector('[role="menu"]'));
      const theme = menuItem('Theme')!;
      await fingers.tap(1, centerOf(theme));
      await sleep(150);
      const midnight = menuItem('Midnight');
      expect(midnight).toBeTruthy();
      await fingers.tap(1, centerOf(midnight!));
      await until(() => s.prefs.getState().theme === 'midnight');
      s.prefs.getState().set({ theme: 'marble' });
    });

    it('menu rows are at least 40 px tall in the touch layout', async () => {
      s.prefs.getState().set({ touchLayout: 'on' });
      await frames(2);
      await fingers.tap(1, centerOf(label('view')));
      await until(() => !!document.querySelector('[role="menu"]'));
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
      expect(rows.length).toBeGreaterThan(5);
      expect(rows.map((r) => `${r.textContent}: ${Math.round(r.getBoundingClientRect().height)}`).filter((t) => parseInt(t.split(': ').pop()!) < 40)).toEqual([]);
    });

    it('the search button (touch layout only) opens the action search, and a tap on a row runs it', async () => {
      expect(host.querySelector('button[aria-label^="Search actions"]')).toBeNull();
      s.prefs.getState().set({ touchLayout: 'on' });
      await until(() => !!host.querySelector('button[aria-label^="Search actions"]'));
      const button = host.querySelector<HTMLElement>('button[aria-label^="Search actions"]')!;
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
      await fingers.tap(1, centerOf(button));
      await until(() => paletteStore.getState().open);
      await until(() => !!document.querySelector('[role="option"]'));
      const rows = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(rows[0]!.getBoundingClientRect().height).toBeGreaterThanOrEqual(39);
      const metronome = s.prefs.getState().metronome;
      const target = rows.find((r) => r.textContent?.includes('Metronome')) ?? rows[0]!;
      await fingers.tap(1, centerOf(target));
      await until(() => !paletteStore.getState().open);
      expect(typeof metronome).toBe('boolean');
    });
  });

  describe('hints', () => {
    it('a finger that rests on a button shows its hint, and lifting does not press the button', async () => {
      const play = host.querySelector<HTMLElement>('button[aria-label="Play / stop"]')!;
      const tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
      expect(tip.hidden).toBe(true);
      const wasPlaying = s.engine.playing;
      await fingers.press(1, centerOf(play));
      await until(() => tip.hidden === false);
      expect(tip.textContent!.length).toBeGreaterThan(5);
      await fingers.lift(1);
      await sleep(150);
      expect(s.engine.playing).toBe(wasPlaying);
      // The hint goes away by itself.
      await until(() => tip.hidden === true, 6000);
    });

    it('shows the hint even when tooltips are switched off (a touchscreen cannot hover)', async () => {
      s.prefs.getState().set({ tooltips: false });
      const play = host.querySelector<HTMLElement>('button[aria-label="Play / stop"]')!;
      const tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
      await fingers.press(1, centerOf(play));
      await until(() => tip.hidden === false);
      await fingers.lift(1);
      s.prefs.getState().set({ tooltips: true });
    });
  });

  describe('touch layout setting', () => {
    it('follows the device on Auto (a coarse main pointer), and On and Off override it', () => {
      const root = document.documentElement;
      const stop = installTouchLayout(s.prefs, () => true);
      s.prefs.getState().set({ touchLayout: 'auto' });
      expect(root.dataset.touch).toBe('on');
      s.prefs.getState().set({ touchLayout: 'off' });
      expect(root.dataset.touch).toBe('off');
      s.prefs.getState().set({ touchLayout: 'on' });
      expect(root.dataset.touch).toBe('on');
      stop();
    });

    it('the command and the settings window switch it, and the menu shows it ticked', async () => {
      s.commands.run('options.touchLayout', 'on');
      expect(document.documentElement.dataset.touch).toBe('on');
      expect(s.commands.isChecked('options.touchLayout')).toBe(true);
      s.commands.run('options.touchLayout');
      expect(s.prefs.getState().touchLayout).toBe('off');
      expect(document.documentElement.dataset.touch).toBe('off');
      s.commands.run('options.touchLayout', 'auto');
      expect(s.prefs.getState().touchLayout).toBe('auto');
      s.prefs.getState().set({ touchLayout: 'off' });
    });
  });

  describe('step sequencer', () => {
    it('paints steps along a finger, as one undo step, and a tap on a lit step turns it off', async () => {
      const rows = [...host.querySelectorAll<HTMLElement>('[data-steps]')];
      const row = rows[0]!;
      const steps = [...row.querySelectorAll<HTMLElement>('[data-step]')];
      const lit = () => steps.filter((b) => b.getAttribute('aria-pressed') === 'true').length;
      const before = lit();
      const cursor = s.history.status().cursor;
      const first = steps.find((b) => b.getAttribute('aria-pressed') !== 'true' && b.dataset.step === '1')!;
      const last = steps.find((b) => b.dataset.step === '6')!;
      const from = centerOf(first);
      await fingers.press(1, from);
      await fingers.drag(1, { x: centerOf(last).x, y: from.y }, 10);
      await fingers.lift(1);
      await frames(3);
      const painted = steps.filter((b) => b.getAttribute('aria-pressed') === 'true');
      expect(painted.length).toBeGreaterThanOrEqual(before + 4);
      expect(['1', '2', '3', '4', '5', '6'].every((i) => steps[Number(i)]!.getAttribute('aria-pressed') === 'true')).toBe(true);
      expect(s.history.status().cursor).toBe(cursor + 1);
      // A tap on a lit step turns it off.
      await fingers.tap(1, centerOf(steps[3]!));
      await frames(3);
      expect(steps[3]!.getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('Keys panel', () => {
    let events: LiveEvent[] = [];
    let times: Array<{ key: number; handled: number; created: number }> = [];
    let stopListening: () => void;
    let panel: HTMLElement;
    const piano = () => panel.querySelector<HTMLElement>('[role="tablist"] + div, [data-touch-own]')!;
    const key = (note: number) => panel.querySelector<HTMLElement>(`[data-key="${note}"]`)!;
    const noteOns = () => events.filter((e) => e.type === 'noteOn');

    beforeAll(async () => {
      s.commands.run('view.keys');
      await until(() => !!windowEl('keys'));
      s.view.getState().setMaximized('keys', true);
      await frames(3);
      panel = windowEl('keys');
    });

    beforeEach(async () => {
      events = [];
      times = [];
      stopListening?.();
      stopListening = s.live.subscribe((e) => {
        events.push(e);
      });
      s.prefs.getState().set({ keysVelocity: 'position' });
      s.live.releaseAll('screen');
      // Every test starts on the piano page.
      const pianoTab = [...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Piano');
      if (pianoTab && pianoTab.getAttribute('aria-selected') !== 'true') pianoTab.click();
      await frames(3);
    });

    afterAll(() => {
      stopListening?.();
      void times;
    });

    it('opens from the View menu command and shows a piano of white and black keys', () => {
      expect(piano()).toBeTruthy();
      // Three octaves and the C above: 37 keys, 22 white and 15 black.
      expect(panel.querySelectorAll('[data-key]').length).toBe(37);
      expect(key(60)).toBeTruthy();
    });

    it('every finger plays its own note: three fingers make a chord, and lifting one stops only its note', async () => {
      const [c, e, g] = [60, 64, 67].map((n) => centerOf(key(n)));
      await fingers.press(1, { x: c!.x, y: key(60).getBoundingClientRect().bottom - 20 });
      await fingers.press(2, { x: e!.x, y: key(64).getBoundingClientRect().bottom - 20 });
      await fingers.press(3, { x: g!.x, y: key(67).getBoundingClientRect().bottom - 20 });
      await frames(2);
      expect(noteOns().map((n) => (n as { key: number }).key).sort()).toEqual([60, 64, 67]);
      expect(s.live.heldKeys().sort()).toEqual([60, 64, 67]);
      await fingers.lift(2);
      await frames(2);
      expect(s.live.heldKeys().sort()).toEqual([60, 67]);
      await fingers.liftAll();
      await frames(2);
      expect(s.live.heldKeys()).toEqual([]);
    });

    it('a black key and the white key behind it sound separately', async () => {
      const black = key(61);
      await fingers.press(1, centerOf(black));
      await frames(1);
      expect(s.live.heldKeys()).toEqual([61]);
      await fingers.liftAll();
    });

    it('velocity comes from where the finger lands (lower is louder), or from the chosen level', async () => {
      const box = key(60).getBoundingClientRect();
      await fingers.press(1, { x: box.left + box.width / 2, y: box.top + box.height * 0.1 });
      await fingers.lift(1);
      await fingers.press(1, { x: box.left + box.width / 2, y: box.top + box.height * 0.9 });
      await fingers.lift(1);
      const [soft, loud] = noteOns().map((n) => (n as { velocity: number }).velocity);
      expect(soft!).toBeLessThan(0.45);
      expect(loud!).toBeGreaterThan(0.85);
      events = [];
      s.commands.run('keys.velocity', 'medium');
      await frames(2);
      await fingers.press(1, { x: box.left + box.width / 2, y: box.top + box.height * 0.1 });
      await fingers.lift(1);
      expect((noteOns()[0] as { velocity: number }).velocity).toBeCloseTo(0.7);
    });

    it('sliding a finger across the keys plays each key it reaches, and stops the one it leaves', async () => {
      const from = centerOf(key(60));
      await fingers.press(1, { x: from.x, y: key(60).getBoundingClientRect().bottom - 15 });
      await fingers.drag(1, { x: centerOf(key(65)).x, y: from.y + 20 }, 12);
      const keysPlayed = noteOns().map((n) => (n as { key: number }).key);
      expect(keysPlayed[0]).toBe(60);
      expect(keysPlayed.length).toBeGreaterThanOrEqual(3);
      expect(s.live.heldKeys()).toHaveLength(1);
      await fingers.lift(1);
      expect(s.live.heldKeys()).toEqual([]);
    });

    it('the pads play with several fingers too: four pads at once, keys 36 to 51, nothing on a slide', async () => {
      const tab = [...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Pads')!;
      await fingers.tap(1, centerOf(tab));
      await until(() => !!panel.querySelector('[data-key="36"]'));
      expect(panel.querySelectorAll('[data-key]').length).toBe(16);
      const pads = [36, 37, 40, 51].map((n) => centerOf(key(n)));
      for (let i = 0; i < pads.length; i++) await fingers.press(i + 1, pads[i]!);
      await frames(2);
      expect(noteOns().map((n) => (n as { key: number }).key).sort((a, b) => a - b)).toEqual([36, 37, 40, 51]);
      await fingers.liftAll();
      events = [];
      // A finger that slides from one pad to the next does not hit the second.
      await fingers.press(1, centerOf(key(36)));
      await fingers.drag(1, centerOf(key(37)), 8);
      expect(noteOns()).toHaveLength(1);
      await fingers.liftAll();
    });

    it('a pad hit in the middle plays louder than one at the corner', async () => {
      [...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Pads')!.click();
      await until(() => !!panel.querySelector('[data-key="36"]'));
      const box = key(36).getBoundingClientRect();
      events = [];
      await fingers.tap(1, { x: box.left + 3, y: box.top + 3 });
      await fingers.tap(1, centerOf(key(36)));
      const [corner, middle] = noteOns().map((n) => (n as { velocity: number }).velocity);
      expect(middle!).toBeGreaterThan(corner! + 0.3);
    });

    it('plays at once: the note starts within a few milliseconds of the touch event (best of five taps)', async () => {
      const target = key(62);
      const created: number[] = [];
      const record = (event: Event) => created.push(event.timeStamp);
      target.addEventListener('pointerdown', record);
      const handled: number[] = [];
      const stop = s.live.subscribe((e) => {
        if (e.type === 'noteOn') handled.push(performance.now());
      });
      for (let i = 0; i < 5; i++) {
        await fingers.tap(1, centerOf(target));
        await sleep(30);
      }
      stop();
      target.removeEventListener('pointerdown', record);
      expect(created).toHaveLength(5);
      expect(handled).toHaveLength(5);
      // The same event's time stamp goes to the note (the path the typing piano uses) and the handler runs in the same task.
      // A busy machine delays any one tap, never all five.
      const delays = handled.map((time, i) => time - created[i]!);
      expect(Math.min(...delays)).toBeLessThan(25);
    });

    it('releases everything when the window closes', async () => {
      await fingers.press(1, centerOf(key(62)));
      s.view.getState().hideWindow('keys');
      await frames(3);
      expect(s.live.heldKeys()).toEqual([]);
      await fingers.liftAll();
      s.commands.run('view.keys');
      await until(() => !!windowEl('keys'));
    });
  });
});
