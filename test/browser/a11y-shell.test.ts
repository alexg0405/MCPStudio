/**
 * Accessibility of the shell (headless Chrome, the real React tree): what the live region says, moving between windows
 * with the keyboard, windows as labelled dialogs, focus following keyboard-opened windows, Space and Enter pressing a
 * keyboard-focused button, and the interface size, contrast, motion and colour-blind settings reaching the page.
 * The contrast numbers are in a11y-contrast.test.ts; the per-element checks (names, roles, tab order) in a11y-audit.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { page } from 'vitest/browser';
import { createServices, type Services } from '@app/services';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { createPrefsStore } from '@app/stores/prefs';
import { registerFeatures } from '@ui/features';
import { liveRegionText, recentAnnouncements, resetAnnouncements, announce } from '@ui/a11y/announce';
import { setKeyboardUsed } from '@ui/a11y/modality';
import { installAccessibilityPrefs } from '@ui/a11y/preferences';
import { installRoving } from '@ui/a11y/roving';
import { currentPanes } from '@ui/features/accessibility/panes';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { fontPx } from '@ui/timeline/canvas';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 20_000, what = 'a condition') => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Presses a key chord on the page the way the keyboard handler hears it. */
function press(code: string, options: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe('accessibility of the shell', () => {
  let s: Services;
  let root: Root;
  let host: HTMLDivElement;
  let stopPrefs: () => void;
  let stopRoving: () => void;
  let commits = 0;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await page.viewport(1440, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0';
    host.id = 'root';
    document.body.append(host);
    const plugins = new PluginRegistry();
    await installPluginDiscovery(plugins);
    s = createServices({ plugins });
    registerFeatures(s);
    installKeyboard(s);
    stopRoving = installRoving();
    stopPrefs = installAccessibilityPrefs(s.prefs);
    applyDefaultLayout(s);
    root = createRoot(host);
    root.render(
      createElement(Profiler, { id: 'app', onRender: () => void commits++ }, createElement(ServicesProvider, { services: s, children: createElement(App) })),
    );
    await until(() => !!host.querySelector('header'));
    await frame();
  });

  afterAll(async () => {
    stopPrefs();
    stopRoving();
    root.unmount();
    host.remove();
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    s.prefs.getState().set({ uiScale: 100, highContrast: 'auto', reduceMotion: 'auto', colorSafe: false });
    setKeyboardUsed(false);
    (document.activeElement as HTMLElement | null)?.blur();
  });

  describe('the live region', () => {
    it('says playing and stopped, and the record, mode and toast messages', async () => {
      resetAnnouncements();
      await s.engine.resume();
      await until(() => s.engine.state === 'running');
      s.commands.run('transport.playPause');
      await until(() => liveRegionText() === 'Playing', 10_000, 'the Playing announcement');
      s.commands.run('transport.stop');
      await until(() => liveRegionText() === 'Stopped', 10_000, 'the Stopped announcement');

      s.recording.setArmed(true);
      expect(liveRegionText()).toContain('Recording armed');
      s.recording.setArmed(false);
      expect(liveRegionText()).toBe('Recording off');

      s.view.getState().setMode('song');
      expect(liveRegionText()).toContain('Song mode');
      s.view.getState().setMode('pattern');
      expect(liveRegionText()).toContain('Pattern mode');

      s.session.getState().toast('Exported “Night drive”');
      expect(liveRegionText()).toBe('Exported “Night drive”');
      s.session.getState().toast('The disk is full', 'error');
      expect(liveRegionText('assertive')).toBe('Error: The disk is full');
      expect(recentAnnouncements().at(-1)).toBe('Error: The disk is full');
    });

    it('reads the Studio’s replies, and says when it starts working', () => {
      resetAnnouncements();
      s.assistant.store.setState({ phase: 'thinking' });
      expect(liveRegionText()).toBe('Studio is working');
      s.assistant.store.setState({
        phase: 'idle',
        messages: [...s.assistant.store.getState().messages, { id: 9001, from: 'assistant', text: 'I added a bass line and a hi-hat pattern.' }],
      });
      expect(liveRegionText()).toBe('Studio: I added a bass line and a hi-hat pattern.');
      const long = 'word '.repeat(300);
      s.assistant.store.setState({ messages: [...s.assistant.store.getState().messages, { id: 9002, from: 'assistant', text: long }] });
      expect(liveRegionText().length).toBeLessThan(520);
      expect(liveRegionText()).toContain('the rest is in the Studio window');
      s.assistant.store.setState({ messages: [...s.assistant.store.getState().messages, { id: 9003, from: 'assistant', text: 'That did not work.', error: true }] });
      expect(liveRegionText('assertive')).toBe('Studio: That did not work.');
    });

    it('speaks the same message twice in a row (the text changes by an invisible mark)', () => {
      resetAnnouncements();
      const region = () => document.querySelector('[data-ag-live="polite"]')!.textContent;
      announce('Playing');
      const first = region();
      announce('Playing');
      const second = region();
      expect(first).not.toBe(second);
      expect(liveRegionText()).toBe('Playing');
    });

    it('has a polite status region and an assertive alert region, hidden from sight', () => {
      announce('x');
      announce('y', 'assertive');
      const polite = document.querySelector<HTMLElement>('[data-ag-live="polite"]')!;
      const assertive = document.querySelector<HTMLElement>('[data-ag-live="assertive"]')!;
      expect(polite.getAttribute('role')).toBe('status');
      expect(polite.getAttribute('aria-live')).toBe('polite');
      expect(assertive.getAttribute('role')).toBe('alert');
      expect(assertive.getAttribute('aria-live')).toBe('assertive');
      expect(polite.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    });
  });

  it('makes no React commits while the song plays: announcing, roving focus and the settings listeners cost nothing per frame', async () => {
    await s.engine.resume();
    await until(() => s.engine.state === 'running');
    s.view.getState().setMode('song');
    s.engine.play(0);
    await until(() => s.engine.playing, 10_000, 'playback');
    // Whatever the start of playback renders (lazy windows arriving on a busy machine) settles; then a stretch of frames
    // must pass with no commit at all. A commit on every frame would never leave such a stretch.
    const frames = async (n: number) => {
      for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    };
    let quiet = false;
    for (let attempt = 0; attempt < 8 && !quiet; attempt++) {
      const before = commits;
      await frames(40);
      quiet = commits === before;
    }
    expect(quiet, 'a stretch of 40 frames with no React commit while playing').toBe(true);
    s.engine.stop();
    s.view.getState().setMode('pattern');
  });

  describe('windows', () => {
    it('every window is a dialog named by its title', async () => {
      for (const type of ['mixer', 'channel-rack', 'piano-roll', 'playlist', 'settings']) openWindow(s, type, null);
      await frame();
      const windows = [...host.querySelectorAll<HTMLElement>('[data-window-id]')];
      expect(windows.length).toBeGreaterThanOrEqual(5);
      for (const win of windows) {
        expect(win.getAttribute('role')).toBe('dialog');
        const label = win.getAttribute('aria-label') ?? '';
        expect(label.length, win.dataset.windowId).toBeGreaterThan(0);
        expect(win.querySelector('[class*="title"]')?.textContent ?? '', win.dataset.windowId).toContain(label);
        // A dialog that does not block the rest of the page.
        expect(win.getAttribute('aria-modal')).toBeNull();
      }
    });

    it('Escape closes a window from its frame, but not from inside its content', async () => {
      const id = openWindow(s, 'history', null);
      await until(() => !!host.querySelector(`[data-window-id="${id}"]`));
      const win = host.querySelector<HTMLElement>(`[data-window-id="${id}"]`)!;
      const inner = win.querySelector<HTMLElement>('[data-window-body]')!;
      inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await frame();
      expect(s.view.getState().windows[id]?.visible).toBe(true);
      win.focus();
      win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => s.view.getState().windows[id]?.visible === false);
    });

    it('a window opened after a key press takes the keyboard; one opened with the mouse does not', async () => {
      s.view.getState().hideWindow('mixer');
      await frame();
      setKeyboardUsed(true);
      openWindow(s, 'mixer', null);
      await until(() => !!document.activeElement?.closest('[data-window-id="mixer"]'), 5000, 'focus inside the mixer');
      expect(liveRegionText()).toBe('Mixer window');

      // Mouse: the focus stays where the person put it.
      const anchor = host.querySelector<HTMLElement>('header button')!;
      anchor.focus();
      setKeyboardUsed(false);
      s.view.getState().hideWindow('history');
      openWindow(s, 'history', null);
      await frame();
      await frame();
      expect(document.activeElement).toBe(anchor);
    });

    it('keyboard focus entering a window makes it the focused window (its shortcuts apply)', async () => {
      const rack = host.querySelector<HTMLElement>('[data-window-id="channel-rack"]')!;
      const mixer = host.querySelector<HTMLElement>('[data-window-id="mixer"]')!;
      mixer.focus();
      await until(() => s.view.getState().focusedId === 'mixer');
      rack.focus();
      await until(() => s.view.getState().focusedId === 'channel-rack');
    });
  });

  describe('moving between the parts of the screen', () => {
    it('Ctrl+F6 goes through the menu bar, the transport, the browser and every window, and comes back; Ctrl+Shift+F6 goes the other way', async () => {
      const panes = currentPanes();
      expect(panes.map((p) => p.label)).toEqual(expect.arrayContaining(['Menu bar', 'Transport', 'Browser']));
      expect(panes.length).toBeGreaterThanOrEqual(6);
      (document.activeElement as HTMLElement | null)?.blur();
      const visited: string[] = [];
      for (let i = 0; i < panes.length; i++) {
        const event = press('F6', { ctrlKey: true });
        expect(event.defaultPrevented, 'the key is taken').toBe(true);
        await frame();
        const active = document.activeElement;
        const at = currentPanes().findIndex((p) => p.element.contains(active));
        expect(at, `the focus is in pane ${i + 1}`).toBeGreaterThanOrEqual(0);
        visited.push(currentPanes()[at]!.label);
      }
      expect(new Set(visited).size, 'every pane was visited once').toBe(panes.length);
      expect(visited[0]).toBe('Menu bar');
      // One more press is the first pane again; Shift goes back to the last.
      press('F6', { ctrlKey: true });
      await frame();
      expect(currentPanes().find((p) => p.element.contains(document.activeElement))?.label).toBe('Menu bar');
      press('F6', { ctrlKey: true, shiftKey: true });
      await frame();
      expect(currentPanes().find((p) => p.element.contains(document.activeElement))?.label).toBe(visited.at(-1));
    });

    it('Alt+9 does the same where F-keys need Fn, and the focused window follows', async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      let landedInAWindow = false;
      for (let i = 0; i < currentPanes().length && !landedInAWindow; i++) {
        press('Digit9', { altKey: true });
        await frame();
        const win = document.activeElement?.closest<HTMLElement>('[data-window-id]');
        if (win) {
          landedInAWindow = true;
          expect(s.view.getState().focusedId).toBe(win.dataset.windowId);
        }
      }
      expect(landedInAWindow).toBe(true);
    });

    it('Alt+0 says where you are', async () => {
      resetAnnouncements();
      s.engine.stop();
      await until(() => !s.engine.playing, 10_000, 'playback to stop');
      const win = host.querySelector<HTMLElement>('[data-window-id="mixer"]')!;
      win.focus();
      press('Digit0', { altKey: true });
      expect(liveRegionText()).toMatch(/^In Mixer/);
      expect(liveRegionText()).toMatch(/stopped in (pattern|song) mode, position \d+:\d\d:\d{3}, \d+ beats per minute\.$/);
    });
  });

  describe('Space and Enter on a control the keyboard is on', () => {
    it('press the control instead of running the shortcut; elsewhere Space still plays', () => {
      const button = host.querySelector<HTMLButtonElement>('header button[aria-label="Metronome"]')!;
      expect(button).toBeTruthy();
      button.focus({ focusVisible: true } as FocusOptions);
      expect(button.matches(':focus-visible')).toBe(true);
      const onButton = press('Space', { key: ' ' }, button);
      expect(onButton.defaultPrevented, 'the button keeps its own Space').toBe(false);
      const onEnter = press('Enter', { key: 'Enter' }, button);
      expect(onEnter.defaultPrevented).toBe(false);
      button.blur();
      const elsewhere = press('Space', { key: ' ' });
      expect(elsewhere.defaultPrevented, 'Space is the play shortcut').toBe(true);
      s.commands.run('transport.stop');
    });
  });

  describe('the settings reach the page', () => {
    it('the interface size scales text, canvas text and the toolbar', async () => {
      const bar = host.querySelector<HTMLElement>('header')!;
      const probe = document.createElement('span');
      probe.style.fontSize = 'var(--ag-font-size)';
      document.body.append(probe);
      const normal = parseFloat(getComputedStyle(probe).fontSize);
      const barNormal = bar.getBoundingClientRect().height;
      expect(fontPx(10)).toBe(10);
      s.prefs.getState().set({ uiScale: 150 });
      await frame();
      expect(parseFloat(getComputedStyle(probe).fontSize)).toBeCloseTo(normal * 1.5, 1);
      expect(fontPx(10)).toBe(15);
      expect(bar.getBoundingClientRect().height).toBeGreaterThan(barNormal * 1.3);
      s.prefs.getState().set({ uiScale: 90 });
      await frame();
      expect(parseFloat(getComputedStyle(probe).fontSize)).toBeCloseTo(normal * 0.9, 1);
      s.prefs.getState().set({ uiScale: 100 });
      await frame();
      expect(document.documentElement.style.getPropertyValue('--ag-scale')).toBe('');
      expect(fontPx(10)).toBe(10);
      probe.remove();
    });

    it('high contrast, less motion and colour-blind safe colours set their attributes; "auto" follows the system', async () => {
      const html = document.documentElement;
      s.prefs.getState().set({ highContrast: 'on', reduceMotion: 'on', colorSafe: true });
      expect(html.dataset.contrast).toBe('more');
      expect(html.dataset.motion).toBe('reduced');
      expect(html.dataset.palette).toBe('safe');
      // Transitions really are off.
      const button = host.querySelector<HTMLElement>('header button')!;
      expect(getComputedStyle(button).transitionDuration.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
      s.prefs.getState().set({ highContrast: 'off', reduceMotion: 'off', colorSafe: false });
      expect(html.dataset.contrast).toBeUndefined();
      expect(html.dataset.motion).toBe('full');
      expect(html.dataset.palette).toBeUndefined();

      // A computer set to increase contrast and reduce motion, on a separate preferences store.
      const own = createPrefsStore();
      own.getState().set({ highContrast: 'auto', reduceMotion: 'auto', colorSafe: false });
      const stop = installAccessibilityPrefs(own, { prefersMoreContrast: () => true, prefersReducedMotion: () => true });
      expect(html.dataset.contrast).toBe('more');
      expect(html.dataset.motion).toBe('reduced');
      own.getState().set({ highContrast: 'off', reduceMotion: 'off' });
      expect(html.dataset.contrast).toBeUndefined();
      expect(html.dataset.motion).toBe('full');
      stop();
      html.removeAttribute('data-motion');
      s.prefs.getState().set({ highContrast: 'on' });
      s.prefs.getState().set({ highContrast: 'auto', reduceMotion: 'auto' });
    });

    it('the commands, the menu and the Settings window carry the same settings', async () => {
      s.commands.run('options.uiScale', 125);
      expect(s.prefs.getState().uiScale).toBe(125);
      s.commands.run('options.uiScale', 'bigger');
      expect(s.prefs.getState().uiScale).toBe(135);
      s.commands.run('options.uiScaleDown');
      expect(s.prefs.getState().uiScale).toBe(125);
      s.commands.run('options.uiScale', 'reset');
      expect(s.prefs.getState().uiScale).toBe(100);
      s.commands.run('options.highContrast', 'on');
      expect(s.prefs.getState().highContrast).toBe('on');
      s.commands.run('options.reduceMotion');
      expect(s.prefs.getState().reduceMotion).toBe('on');
      s.commands.run('options.colorSafe');
      expect(s.prefs.getState().colorSafe).toBe(true);

      openWindow(s, 'settings', null);
      await until(() => !!host.querySelector('[data-window-id="settings"] input[type="range"]'), 20_000, 'the Settings window');
      const slider = host.querySelector<HTMLInputElement>('[data-window-id="settings"] input[type="range"]')!;
      expect(slider.getAttribute('aria-label')).toBe('Interface size');
      expect(slider.getAttribute('aria-valuetext')).toBe('100 percent');
      const text = host.querySelector<HTMLElement>('[data-window-id="settings"]')!.innerText;
      for (const label of ['Interface size', 'High contrast', 'Less motion', 'Colour-blind safe colours']) expect(text).toContain(label);
    });
  });
});
