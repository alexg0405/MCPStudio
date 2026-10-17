/**
 * A long channel rack (an AI-arranged song can have 150 channels) keeps only the rows near the viewport in the DOM; the
 * scroll height stays that of all rows, the last channel can be reached, and the step graph (taller row) shows every row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addKitChannel } from '@app/actions/channels';
import { KIT } from '@core/model/kit';
import { registerFeatures } from '@ui/features';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe('long channel rack (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  const rack = () => host.querySelector<HTMLElement>('[data-window-type="channel-rack"]')!;
  const scroller = () => rack().querySelector<HTMLElement>('[class*="scroll"]')!;
  const rows = () => [...rack().querySelectorAll<HTMLElement>('[data-channel-id]')];

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.view.getState().setCurrentPattern(s.doc.getState().project.patternOrder[0]!);
    for (let i = 0; i < 140; i++) addKitChannel(s, KIT[i % KIT.length]!.generator);
    registerFeatures(s);
    openWindow(s, 'channel-rack');
    s.view.getState().setMaximized('channel-rack', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await frames(6);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('renders a window of the rows and reaches the last one by scrolling', async () => {
    const all = s.doc.getState().project.channelOrder;
    expect(all.length).toBeGreaterThan(100);
    expect(rows().length).toBeGreaterThan(8);
    expect(rows().length).toBeLessThan(60);
    expect(rows()[0]!.dataset.channelId).toBe(all[0]);
    expect(scroller().scrollHeight).toBeGreaterThan(all.length * 32);
    scroller().scrollTop = scroller().scrollHeight;
    await frames(4);
    expect(rows().length).toBeLessThan(60);
    expect(rows().at(-1)!.dataset.channelId).toBe(all.at(-1));
    scroller().scrollTop = 60 * 32;
    await frames(4);
    const ids = rows().map((r) => r.dataset.channelId);
    expect(ids).toContain(all[62]);
    expect(ids).not.toContain(all[0]);
  });

  it('with the step graph open every row is there', async () => {
    const id = s.doc.getState().project.channelOrder[3]!;
    s.session.getState().selectChannel(id);
    s.editor.getState().setStepGraph({ channelId: id });
    await frames(4);
    expect(rows().length).toBe(s.doc.getState().project.channelOrder.length);
    s.editor.getState().setStepGraph({ channelId: null });
    await frames(4);
    expect(rows().length).toBeLessThan(80);
  });
});
