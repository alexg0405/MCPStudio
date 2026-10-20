/**
 * Guided tours, the Help window, the Features page and What's new in the real shell (headless Chrome, the real React tree,
 * test services with the fake engine):
 * - every step of every tour (and every "Show me" of What's new) points at an element that is present, visible and on screen;
 * - the card is a labelled dialog the screen reader announces, the keyboard drives it and keeps the focus inside, and the
 *   focus goes back where it was;
 * - it works in the touch layout (a sheet at the bottom or top, finger-sized buttons);
 * - the musician's project is deep-equal afterwards, however the tour ended;
 * - the Help window searches, a window's "?" links to its tour and to Help, the Features page starts what it lists.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installSessionPersistence } from '@app/persistence/session';
import { createTestServices } from '@app/testing';
import { addChannel } from '@core/ops/channels';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { recentAnnouncements, resetAnnouncements } from '@ui/a11y/announce';
import { registerFeatures } from '@ui/features';
import { paletteStore, togglePalette } from '@ui/features/palette/Palette';
import { findTarget } from '@ui/features/tours/target';
import { spotlight } from '@ui/features/tours/spotlight';
import { TOURS } from '@ui/features/tours/tour-list';
import { endTour, goToStep, startTour, tourStore } from '@ui/features/tours/tour-state';
import { closeWhatsNew } from '@ui/features/whats-new/whats-new-state';
import { WHATS_NEW } from '@ui/features/whats-new/entries';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { installTouchLayout } from '@ui/touch/layout';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import '@ui/touch/touch.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 15_000, what = 'a condition') => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Whether an element is on the page with a size, at least partly inside the window. */
function isShown(el: Element | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.right > 0 &&
    r.bottom > 0 &&
    r.left < window.innerWidth &&
    r.top < window.innerHeight
  );
}

function press(key: string, target: EventTarget = document.body, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe('guided tours, help and what’s new', { timeout: 180_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let stopTouchLayout: () => void;
  const card = () => document.querySelector<HTMLElement>('[data-tour-overlay] [role="dialog"]');
  const hole = () => document.querySelector<HTMLElement>('[data-tour-overlay] [aria-hidden="true"]');
  const button = (label: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    );
  const windowEl = (type: string) => document.querySelector<HTMLElement>(`[data-window-type="${type}"]`);

  beforeAll(async () => {
    await page.viewport(1440, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0';
    host.id = 'root';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true, whatsNewSeen: '2026.10' });
    registerFeatures(s);
    installKeyboard(s);
    stopTouchLayout = installTouchLayout(s.prefs, () => false);
    applyDefaultLayout(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    await frame();
  });

  afterEach(async () => {
    endTour(s);
    closeWhatsNew();
    if (paletteStore.getState().open) paletteStore.setState({ open: false, query: '' });
    s.prefs.getState().set({ touchLayout: 'off' });
    await page.viewport(1440, 900);
    await frame();
  });

  afterAll(async () => {
    stopTouchLayout();
    root.unmount();
    host.remove();
    await s.engine.dispose();
  });

  it('points every step of every tour at something that is present, visible and on screen, with the highlight on it', async () => {
    const problems: string[] = [];
    for (const tour of TOURS) {
      await startTour(s, tour.id);
      await until(() => card() !== null, 5_000, `the first card of ${tour.id}`);
      for (const [i, step] of tour.steps.entries()) {
        goToStep(s, i);
        const arrived = await until(
          () => isShown(findTarget(step.target)),
          5_000,
          `${tour.id}/${step.id}: ${step.target}`,
        ).then(
          () => true,
          () => false,
        );
        if (!arrived) {
          problems.push(`${tour.id}/${step.id}: ${step.target} is not on screen`);
          continue;
        }
        // The highlight glides to its target (a short transition), then surrounds it with a few pixels of padding.
        const surrounds = () => {
          const target = findTarget(step.target)!.getBoundingClientRect();
          const spot = hole()?.getBoundingClientRect();
          return (
            !!spot &&
            spot.left <= target.left + 0.5 &&
            spot.top <= target.top + 0.5 &&
            spot.right >= target.right - 0.5 &&
            spot.bottom >= target.bottom - 0.5
          );
        };
        const settled = await until(surrounds, 3_000, 'the highlight').then(
          () => true,
          () => false,
        );
        if (!settled) problems.push(`${tour.id}/${step.id}: the highlight does not surround ${step.target}`);
        if (!card()?.textContent?.includes(step.title))
          problems.push(`${tour.id}/${step.id}: the card does not show its title`);
        const c = card()!.getBoundingClientRect();
        if (c.left < 0 || c.top < 0 || c.right > window.innerWidth || c.bottom > window.innerHeight)
          problems.push(`${tour.id}/${step.id}: the card sticks out of the window`);
      }
      endTour(s);
    }
    expect(problems).toEqual([]);
  });

  it('points every “Show me” of What’s new at something on screen', async () => {
    const problems: string[] = [];
    for (const entry of WHATS_NEW) {
      await startTour(s, spotlight(entry.show), { demo: false });
      const ok = await until(() => isShown(findTarget(entry.show.target)), 5_000, entry.id).then(
        () => true,
        () => false,
      );
      if (!ok) problems.push(`${entry.id}: ${entry.show.target}`);
      endTour(s);
    }
    expect(problems).toEqual([]);
  });

  it('is a labelled dialog that takes the focus, is announced as it moves, and gives the focus back', async () => {
    const opener = document.querySelector<HTMLElement>('[data-menu="help"]')!;
    opener.focus();
    resetAnnouncements();
    await startTour(s, 'first-song');
    await until(() => card() !== null);
    const el = card()!;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    const name = el
      .getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(name).toMatch(/Make your first song: step 1 of 7/);
    expect(name).toContain('1. Pick your sounds');
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toContain('browser');
    expect(el.contains(document.activeElement)).toBe(true);
    expect(recentAnnouncements().some((m) => m.startsWith('Tour: Make your first song. 7 steps'))).toBe(true);

    button('Next', el)!.click();
    await until(() => recentAnnouncements().some((m) => m.startsWith('Step 2 of 7: 2. Make a beat.')));
    // The arrow keys work from anywhere in the page and the card keeps the focus inside.
    press('ArrowRight');
    await until(() => tourStore.getState().run?.step === 2);
    press('ArrowLeft');
    await until(() => tourStore.getState().run?.step === 1);
    const buttons = [...card()!.querySelectorAll<HTMLButtonElement>('button')];
    buttons[buttons.length - 1]!.focus();
    const tab = press('Tab', buttons[buttons.length - 1]!);
    expect(tab.defaultPrevented).toBe(true);
    expect(card()!.contains(document.activeElement)).toBe(true);
    buttons[0]!.focus();
    press('Tab', buttons[0]!, { shiftKey: true });
    expect(card()!.contains(document.activeElement)).toBe(true);

    press('Escape');
    await until(() => card() === null);
    expect(recentAnnouncements().some((m) => m.startsWith('Tour finished. Your project is back'))).toBe(true);
    await until(() => document.activeElement === opener, 3_000, 'the focus to go back to where it was');
  });

  it('works in the touch layout: a sheet inside the screen, finger-sized buttons, every card reachable', async () => {
    await page.viewport(820, 1180);
    s.prefs.getState().set({ touchLayout: 'on' });
    await frame();
    await startTour(s, 'first-song');
    await until(() => card() !== null);
    for (const [i, step] of TOURS.find((t) => t.id === 'first-song')!.steps.entries()) {
      goToStep(s, i);
      await until(() => card()?.textContent?.includes(step.title) ?? false, 5_000, step.title);
      await frame();
      const el = card()!;
      const r = el.getBoundingClientRect();
      expect(r.left, step.id).toBeGreaterThanOrEqual(0);
      expect(r.right, step.id).toBeLessThanOrEqual(window.innerWidth);
      expect(r.top, step.id).toBeGreaterThanOrEqual(0);
      expect(r.bottom, step.id).toBeLessThanOrEqual(window.innerHeight);
      expect(['top', 'bottom'], step.id).toContain(el.dataset.dock);
      for (const b of el.querySelectorAll('button'))
        expect(b.getBoundingClientRect().height, `${step.id}: ${b.textContent}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('gives the project back deep-equal after every tour, however it ended', async () => {
    s.history.transact('add a synth', (d) =>
      addChannel(d, makeInstrumentChannel('Lead', makePluginInstance('agstudio.3xosc', 1, {}))),
    );
    const project = s.doc.getState().project;
    const copy = structuredClone(project);
    const status = s.history.status();
    for (const [i, tour] of TOURS.entries()) {
      await startTour(s, tour.id);
      await until(() => card() !== null);
      expect(s.doc.getState().project).not.toBe(project);
      if (i % 3 === 0) press('Escape');
      else if (i % 3 === 1) endTour(s);
      else goToStep(s, tour.steps.length);
      await until(() => card() === null);
      expect(s.doc.getState().project, tour.id).toBe(project);
      expect(s.doc.getState().project, tour.id).toEqual(copy);
      expect(s.history.status(), tour.id).toEqual(status);
    }
  });

  it('keeps the musician’s own project in the reload snapshot while a tour shows its demo song', async () => {
    s.history.transact('add a synth', (d) =>
      addChannel(d, makeInstrumentChannel('Lead', makePluginInstance('agstudio.3xosc', 1, {}))),
    );
    const mine = s.doc.getState().project.projectId;
    const persistence = installSessionPersistence(s, 'ses_tour_test');
    try {
      await startTour(s, 'overview');
      await until(() => card() !== null);
      expect(s.doc.getState().project.projectId).not.toBe(mine);
      window.dispatchEvent(new Event('pagehide'));
      const saved = JSON.parse(sessionStorage.getItem('agstudio:tab-snapshot:v2') ?? '{}') as {
        project?: { projectId: string };
        file?: { dirty: boolean };
      };
      expect(saved.project?.projectId).toBe(mine);
      expect(saved.file?.dirty).toBe(true);
    } finally {
      persistence.stop();
    }
  });

  it('opens What’s new from Help, lists every feature with “Show me”, and a click points at the real control', async () => {
    s.commands.run('help.whatsNew');
    await until(() => !!document.querySelector('[data-whats-new]'));
    const panel = document.querySelector<HTMLElement>('[data-whats-new]')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.querySelectorAll('li').length).toBe(WHATS_NEW.length);
    expect(panel.querySelectorAll('svg[aria-hidden="true"]').length).toBe(WHATS_NEW.length);
    expect(panel.contains(document.activeElement)).toBe(true);
    button('Show me: Help, Features and guided tours', panel)!.click();
    await until(() => card() !== null);
    expect(document.querySelector('[data-whats-new]')).toBeNull();
    expect(card()!.textContent).toContain('Help menu');
    expect(isShown(findTarget('menu:help'))).toBe(true);
    press('Escape');
    await until(() => card() === null);

    s.commands.run('help.whatsNew');
    await until(() => !!document.querySelector('[data-whats-new]'));
    press('Escape');
    await until(() => !document.querySelector('[data-whats-new]'));
  });

  it('searches in the Help window, shows a topic with its button, and its button works', async () => {
    s.commands.run('help.open', 'loudness');
    await until(() => !!windowEl('help'));
    const win = windowEl('help')!;
    await until(() => (win.textContent ?? '').includes('Meters'));
    const input = win.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input.value).toBe('loudness');
    const topic = [...win.querySelectorAll<HTMLButtonElement>('ul button')].find((b) =>
      b.textContent?.startsWith('Meters'),
    )!;
    topic.click();
    await until(() => (win.querySelector('article h2')?.textContent ?? '') === 'Meters');
    button('Open Meters', win)!.click();
    await until(() => !!windowEl('meters'));
    // A topic of a tour starts it from the Help window.
    s.commands.run('help.open', { topic: 'tour:dj-mixing' });
    await until(() => (win.querySelector('article h2')?.textContent ?? '') === 'DJ mixing');
    button('Start the tour', win)!.click();
    await until(() => card() !== null);
    expect(tourStore.getState().run?.tour.id).toBe('dj-mixing');
  });

  it('offers the tour and Help under every window’s “?”', async () => {
    openWindow(s, 'mixer');
    await until(() => !!windowEl('mixer'));
    windowEl('mixer')!.querySelector<HTMLButtonElement>('[aria-label="How this window works"]')!.click();
    await until(() => !!button('More in Help', windowEl('mixer')!));
    const tourLink = button('Take the tour: Mixing and mastering', windowEl('mixer')!);
    expect(tourLink).toBeTruthy();
    tourLink!.click();
    await until(() => tourStore.getState().run?.tour.id === 'mix-master');
    endTour(s);
    // The project (and its windows) come back, so the mixer window is drawn again.
    await until(() => card() === null && !!windowEl('mixer')?.querySelector('[aria-label="How this window works"]'));
    await frame();
    windowEl('mixer')!.querySelector<HTMLButtonElement>('[aria-label="How this window works"]')!.click();
    await until(() => !!button('More in Help', windowEl('mixer')!));
    button('More in Help', windowEl('mixer')!)!.click();
    await until(() => (windowEl('help')?.querySelector('article h2')?.textContent ?? '') === 'Mixer');
  });

  it('lists what AGstudio can do on the Features page, and starts it from there', async () => {
    s.commands.run('help.features');
    await until(() => !!windowEl('features'));
    const win = windowEl('features')!;
    await until(() => win.querySelectorAll('section').length >= 10);
    const titles = [...win.querySelectorAll('h3')].map((h) => h.textContent);
    expect(titles).toContain('Mixing and mastering');
    expect(titles).toContain('Clip launcher');
    button('Clip launcher', win.querySelector('section[aria-labelledby="ag-feature-launcher"]')!)!.click();
    await until(() => !!windowEl('launcher'));
    button('Tour: Perform with the clip launcher', win)!.click();
    await until(() => tourStore.getState().run?.tour.id === 'clip-launcher');
    endTour(s);
  });

  it('starts a tour from the action search’s “Learn:” rows', async () => {
    togglePalette('learn dj');
    await until(() => paletteStore.getState().open);
    await until(() =>
      [...document.querySelectorAll('[role="option"]')].some((o) => o.textContent?.includes('Learn: DJ mixing')),
    );
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes('Learn: DJ mixing'),
    )!;
    row.click();
    await until(() => tourStore.getState().run?.tour.id === 'dj-mixing');
  });
});
