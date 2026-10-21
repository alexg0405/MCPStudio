/**
 * The very big project (`app/fixtures/huge-song.ts`) in the browser: how many audio nodes its mixer needs, how quickly an
 * engine builds it and renders it offline, what a frame costs while the playlist scrolls under a following playhead
 * (the playlist, the chord and lyrics lanes and the piano roll all draw), and what a frame costs when nothing moves.
 * `npm run test:perf` holds the real limits, the regular run keeps loose ones (`perfLimit`). The numbers behind them are
 * in docs/architecture.md, "Big projects".
 */
import { produce } from 'immer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { buildHugeSong, HUGE_SIZE } from '@app/fixtures/huge-song';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { PluginRegistry } from '@app/plugins/registry';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { frameStats } from '@ui/frame-loop';
import { registerFeatures } from '@ui/features';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY } from '../helpers/wait';
import { perfLimit, settle } from '../helpers/perf';

const SR = 48000;

function hugeProject(): Project {
  const previous = setIdSource(seededBytes(11));
  try {
    return produce(createEmptyProject({ now: new Date(0) }), (draft) => void buildHugeSong(draft, HUGE_SIZE));
  } finally {
    setIdSource(previous);
  }
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

/** Counts the audio nodes made while `run` goes on, by kind (the constructors are wrapped for the time). */
async function countNodes<T>(run: () => Promise<T>): Promise<{ result: T; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const scope = globalThis as unknown as Record<string, new (...args: unknown[]) => object>;
  const originals = new Map<string, new (...args: unknown[]) => object>();
  for (const name of ['GainNode', 'ConstantSourceNode', 'AudioWorkletNode', 'DelayNode', 'BiquadFilterNode', 'StereoPannerNode']) {
    const Original = scope[name] as new (...args: unknown[]) => object;
    originals.set(name, Original);
    counts[name] = 0;
    scope[name] = class extends Original {
      constructor(...args: unknown[]) {
        super(...args);
        counts[name] = (counts[name] ?? 0) + 1;
      }
    };
  }
  try {
    return { result: await run(), counts };
  } finally {
    for (const [name, Original] of originals) scope[name] = Original;
  }
}

describe('a very big project: the audio engine', { timeout: 300_000 }, () => {
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  const project = hugeProject();
  const BARS = 2;

  const render = () =>
    renderOffline(project, {
      plugins,
      view: { mode: 'song', patternId: null, loop: null },
      bars: BARS,
      sampleRate: SR,
      tail: 0,
    });

  it('builds a mixer of 100 tracks and 450 effects from a few thousand nodes, and renders it', async () => {
    const { result, counts } = await countNodes(render);
    expect(result.buffer.duration).toBeGreaterThan(3);
    // An effect slot at mix 1 is an input, an output and a wet gate (it was nine nodes with the dry/wet stage and its
    // always-running constant source), and a channel at pitch 0 has no pitch sources. Measured on this project: 13,609
    // gains and 1,184 constant sources, against 15,565 and 1,975 before. Offline contexts add a ladder of gains where
    // several things feed one node, which is most of the gains. Going back shows as more than the limits.
    expect(counts.ConstantSourceNode).toBeLessThan(1500);
    expect(counts.GainNode).toBeLessThan(14_500);
  });

  it('renders the song at a tenth of real time or better, with 160 instruments and 450 effects all sounding', { tags: ['perf'] }, async () => {
    const minimum = perfLimit(0.1, 0.01);
    const speed = await settle(
      async () => {
        const t0 = performance.now();
        const done = await render();
        const seconds = (performance.now() - t0) / 1000;
        return done.buffer.duration / seconds;
      },
      (x) => x >= minimum,
      { better: 'higher', attempts: 3 },
    );
    expect(speed).toBeGreaterThanOrEqual(minimum);
  });
});

describe('a very big project: the interface', { timeout: 120_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices({ project: hugeProject() });
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.view.getState().setMode('song');
    registerFeatures(s);
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await frames(6);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('draws the playlist and its lanes', async () => {
    await expect.poll(() => host.querySelector('[data-window-type="playlist"] canvas') !== null, EVENTUALLY).toBe(true);
  });

  it('scrolling under a following playhead costs well under a frame of script', { tags: ['perf'] }, async () => {
    const limitMs = perfLimit(2, 12);
    s.editor.getState().setPlaylist({ pxPerTick: 0.04, scrollTick: 0 });
    await frames(10);
    const median = await settle(
      async () => {
        frameStats.samples.length = 0;
        frameStats.recording = true;
        for (let i = 0; i < 90; i++) {
          s.editor.getState().setPlaylist({ scrollTick: 3840 * 8 + i * 120 });
          await frames(1);
        }
        frameStats.recording = false;
        const sorted = [...frameStats.samples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] as number;
      },
      (ms) => ms <= limitMs,
    );
    expect(median).toBeLessThanOrEqual(limitMs);
  });

  it('an idle frame costs next to nothing', { tags: ['perf'] }, async () => {
    const limitMs = perfLimit(0.3, 3);
    await frames(10);
    const median = await settle(
      async () => {
        frameStats.samples.length = 0;
        frameStats.recording = true;
        await frames(60);
        frameStats.recording = false;
        const sorted = [...frameStats.samples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] as number;
      },
      (ms) => ms <= limitMs,
    );
    expect(median).toBeLessThanOrEqual(limitMs);
  });
});
