/**
 * Follow playhead in the piano roll (headless Chrome, the real React shell, test services with the fake
 * engine): in pattern mode the view turns the page as the pattern plays on; in song mode it follows the
 * clip of this pattern that plays; a hand scroll pauses it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { newId } from '@core/model/ids';
import type { ChannelId, LaneId, PatternId } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { registerFeatures } from '@ui/features';
import { KEYS_WIDTH } from '@ui/features/piano-roll/controller';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const BAR = 3840;
const PX_PER_TICK = 0.1;
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

describe('follow playhead in the piano roll (UI)', { timeout: 30_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let pattern: PatternId;
  const win = () => host.querySelector<HTMLElement>('[data-window-type="piano-roll"]')!;
  const gridHost = () => win().querySelector<HTMLElement>('[class*="gridHost"]')!;
  const width = () => gridHost().getBoundingClientRect().width;
  const visible = () => width() / PX_PER_TICK;
  /** The playhead's x in the grid (NaN while it is hidden). */
  const playheadX = () => {
    const el = win().querySelector<HTMLElement>('[class*="playhead"]')!;
    if (el.style.display === 'none' || !el.style.transform) return NaN;
    return Number(/translateX\(([-\d.]+)px\)/.exec(el.style.transform)?.[1]) - KEYS_WIDTH;
  };
  const nearLeft = () => Math.abs(playheadX() / width() - 0.15) < 0.01;
  const play = (tick: number) => {
    s.fakeEngine.startTick = tick;
    s.engine.play();
  };
  const wheel = (deltaY: number) =>
    gridHost().dispatchEvent(new WheelEvent('wheel', { deltaY, shiftKey: true, bubbles: true, cancelable: true }));

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true, followPlayhead: true });
    const p = s.doc.getState().project;
    pattern = p.patternOrder[0] as PatternId;
    const channel = Object.values(p.channels).find((c) => c.kind === 'instrument')!.id as ChannelId;
    // A 64-bar pattern, so the view has pages to turn.
    s.history.transact('long pattern', (d) => {
      d.patterns[pattern]!.length = 64 * BAR;
    });
    s.view.getState().setCurrentPattern(pattern);
    s.session.getState().selectChannel(channel);
    s.editor.getState().setPianoRoll({ pxPerTick: PX_PER_TICK, scrollTick: 0, scrollRow: 40 });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'piano-roll');
    s.view.getState().setMaximized('piano-roll', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="piano-roll"] [class*="gridHost"]'));
    await frames(3);
  });

  beforeEach(async () => {
    s.engine.stop();
    s.view.getState().setMode('pattern');
    wheel(-1e7);
    await frames(2);
  });

  afterAll(() => {
    s.engine.stop();
    root.unmount();
    host.remove();
  });

  it('pattern mode: turns the page as the playhead nears the right edge, and the toolbar shows the toggle', async () => {
    const toggle = win().querySelector<HTMLElement>('button[aria-pressed]')!;
    expect(toggle.textContent).toBe('Follow');
    expect(toggle.getAttribute('data-hint')).toMatch(/^Follow playhead on/);
    play(0.5 * visible());
    await frames(3);
    expect(playheadX() / width()).toBeCloseTo(0.5, 1);
    s.fakeEngine.startTick = 0.92 * visible();
    await until(nearLeft);
    // A jump off-screen (a seek) comes straight back.
    s.fakeEngine.startTick = 20 * BAR;
    await until(nearLeft);
  });

  it('song mode: follows the clip of this pattern that is playing', async () => {
    const lane = s.doc.getState().project.playlist.laneOrder[0] as LaneId;
    s.history.transact('clip', (d) =>
      addClips(d, [{ kind: 'pattern', id: newId.clip(), laneId: lane, start: 100 * BAR, length: 64 * BAR, patternId: pattern, offset: 0 }]),
    );
    s.view.getState().setMode('song');
    // Ten bars into the clip: the piano roll shows bar 11 of the pattern.
    play(110 * BAR);
    await until(nearLeft);
    // Outside the clip the playhead isn't in this pattern: the view stays put.
    s.fakeEngine.startTick = 50 * BAR;
    await frames(4);
    expect(playheadX()).toBeNaN();
  });

  it('a hand scroll pauses it until playback starts again', async () => {
    play(0.3 * visible());
    await frames(3);
    wheel(3 * width());
    s.fakeEngine.startTick = 0.5 * visible();
    await frames(6);
    expect(playheadX()).toBeNaN();
    s.engine.stop();
    await frames(1);
    play(0.5 * visible() + 10 * BAR);
    await until(nearLeft);
  });
});
