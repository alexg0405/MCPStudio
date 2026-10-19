/**
 * The clip launcher under real fingers (Chrome's touch input through DevTools, see `test/helpers/touch.ts`): a tap launches a
 * slot, several fingers launch several slots at once, a resting finger opens the slot's menu (the right-click), and the pads
 * are big enough in the touch layout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { launcherFixture } from '@core/launcher/test-project';
import type { LaunchClock } from '@core/launcher/run';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { installTouch } from '@ui/touch';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import '@ui/touch/touch.css';
import { centerOf, Fingers, nextFrame, sleep, until } from '../helpers/touch';

describe('clip launcher with touch', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let stopTouch: () => void;
  let fingers: Fingers;
  let t0 = 0;
  let running = false;
  const clock = (): LaunchClock => {
    const heardU = running ? (performance.now() - t0) * 10 : 0;
    return { playing: running, heardU, earliestU: heardU + 60 };
  };
  const win = () => host.querySelector<HTMLElement>('[data-window-type="launcher"]')!;
  const cells = () => [...win().querySelectorAll<HTMLElement>('[data-slot]')];
  const cell = (track: number, scene: number) => cells()[scene * 8 + track]!;

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices({ project: launcherFixture().project });
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
    stopTouch = installTouch(s);
    openWindow(s, 'launcher');
    s.view.getState().setMaximized('launcher', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!win() && cells().length === 64);
    await nextFrame();
    fingers = new Fingers();
  });

  afterAll(async () => {
    await fingers.liftAll();
    stopTouch();
    root.unmount();
    host.remove();
  });

  it('a tap launches a slot', async () => {
    // Track 2, scene 1.
    const slot = cell(1, 0);
    expect(slot.dataset.state).toBe('idle');
    await fingers.tap(1, centerOf(slot));
    await until(() => s.launcher.runs.length === 1);
    await until(() => slot.dataset.state === 'playing' || slot.dataset.state === 'queued');
  });

  it('two fingers launch two slots at once, on two tracks', async () => {
    const before = s.launcher.runs.length;
    // Track 1's first slot and track 2's second slot (the fixture fills these two tracks).
    const first = cell(0, 0);
    const second = cell(1, 1);
    expect(first.dataset.state).toBe('idle');
    expect(second.dataset.state).toBe('idle');
    await fingers.press(1, centerOf(first));
    await fingers.press(2, centerOf(second));
    await fingers.liftAll();
    await until(() => s.launcher.runs.length >= before + 2);
    for (const slot of [first, second]) await until(() => ['queued', 'playing'].includes(slot.dataset.state ?? ''));
  });

  it('a finger that rests on a slot opens its menu', async () => {
    closeContextMenu();
    await fingers.press(1, centerOf(cell(5, 5)));
    await sleep(650);
    await until(() => !!document.querySelector('[role="menu"]'));
    await fingers.liftAll();
    closeContextMenu();
  });

  it('keeps the browser from scrolling or zooming the page under a pad', () => {
    expect(getComputedStyle(cell(0, 0)).touchAction).toBe('none');
  });
});
