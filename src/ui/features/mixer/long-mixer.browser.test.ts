/**
 * A long mixer (a big project has 100 tracks) keeps only the strips near the view in the DOM, with the Master always
 * there; the scroll width stays that of all strips and the last track can be reached by scrolling.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addMixerInsert } from '@app/actions/mixer';
import { registerFeatures } from '@ui/features';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY } from '../../../../test/helpers/wait';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe('long mixer (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  const mixer = () => host.querySelector<HTMLElement>('[data-window-type="mixer"]')!;
  const scroller = () => mixer().querySelector<HTMLElement>('[aria-label="Mixer tracks"]')!;
  const stripNames = () => [...scroller().querySelectorAll<HTMLElement>('[role="group"][aria-label]')].map((e) => e.getAttribute('aria-label')!);

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    for (let i = 0; i < 90; i++) addMixerInsert(s);
    registerFeatures(s);
    openWindow(s, 'mixer');
    s.view.getState().setMaximized('mixer', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await frames(6);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('draws a window of the strips and reaches the last one by scrolling', async () => {
    await expect.poll(() => host.querySelector('[aria-label="Mixer tracks"]') !== null, EVENTUALLY).toBe(true);
    const total = s.doc.getState().project.mixer.order.length;
    expect(total).toBeGreaterThan(100);
    expect(stripNames()[0]).toBe('Master');
    expect(stripNames().length).toBeLessThan(total / 2);
    expect(scroller().scrollWidth).toBeGreaterThan(total * 60);
    scroller().scrollLeft = scroller().scrollWidth;
    await frames(4);
    expect(stripNames()[0]).toBe('Master');
    expect(stripNames().at(-1)).toContain(`Insert ${total - 1}`);
    expect(stripNames().length).toBeLessThan(total / 2);
  });
});
