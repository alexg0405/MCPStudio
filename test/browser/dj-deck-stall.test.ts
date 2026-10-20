/**
 * The "Loading…" note on a stalled deck (headless Chrome, the real DeckPanel over the decks' shared state): the note
 * appears after about 150 ms of stall, hides as soon as the stall clears, never flashes for a shorter stall, and a
 * stall causes no React commits (the note is written imperatively on the frame loop).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import { initialDecksState } from '@app/dj/decks';
import type { DecksApi, DecksState } from '@app/dj/decks-api';
import { createTestServices } from '@app/testing';
import type { SampleRef } from '@core/model/types';
import { DeckPanel } from '@ui/features/dj-decks/DeckPanel';
import { ServicesProvider } from '@ui/services-context';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await wait(4);
  }
};

describe('a stalled deck shows a Loading note (UI)', { timeout: 30_000 }, () => {
  let host: HTMLDivElement;
  let root: Root;
  let commits = 0;
  /** What the fake player reports: the stall flag, read per frame like the real one. */
  let stalled = false;
  const store = createStore<DecksState>(() => initialDecksState());
  const api = {
    store,
    positionNow: () => 12,
    waveformOf: () => null,
    analysisOf: () => null,
    isStalled: () => stalled,
  } as unknown as DecksApi;
  const note = () => host.querySelector<HTMLElement>('[data-hint^="Loading this part of the song"]')!;
  const visible = () => {
    const n = note();
    return !!n && !n.hidden && getComputedStyle(n).display !== 'none';
  };

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:900px;height:600px';
    document.body.append(host);
    const services = createTestServices();
    // A song on deck A, playing: the panel has its waveform and the frame loop runs.
    store.setState((s) => ({
      decks: {
        ...s.decks,
        A: { ...s.decks.A, song: { ref: {} as SampleRef, title: 'Song', durationSec: 240 }, playing: true },
      },
    }));
    root = createRoot(host);
    root.render(
      createElement(
        Profiler,
        { id: 'decks', onRender: () => commits++ },
        createElement(ServicesProvider, { services, children: createElement(DeckPanel, { api, id: 'A' }) }),
      ),
    );
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('the note exists, is hidden and says what it is for while the deck is not stalled', async () => {
    await frames(2);
    expect(note()).not.toBeNull();
    expect(note().hidden).toBe(true);
    expect(note().textContent).toContain('Loading…');
    expect(visible()).toBe(false);
  });

  it('appears after about 150 ms of stall, and hides as soon as the stall clears, with no React commits', async () => {
    const before = commits;
    let writes = 0;
    const watch = new MutationObserver((records) => (writes += records.length));
    watch.observe(note(), { attributes: true, childList: true, subtree: true, characterData: true });

    stalled = true;
    const t0 = performance.now();
    await until(() => visible());
    const shownAfter = performance.now() - t0;
    // About 150 ms: not at the first frame, not much later either (frame timing gives some slack).
    expect(shownAfter).toBeGreaterThanOrEqual(130);
    expect(shownAfter).toBeLessThan(400);

    // Keep it stalled for a while: the frame loop runs, the note stays, nothing is rewritten, nothing re-renders.
    await wait(500);
    expect(visible()).toBe(true);
    expect(writes).toBe(1);
    expect(commits - before).toBe(0);

    stalled = false;
    await frames(2);
    expect(visible()).toBe(false);
    expect(note().hidden).toBe(true);
    watch.disconnect();
    expect(commits - before).toBe(0);
  });

  it('a stall shorter than the delay never shows the note', async () => {
    let everShown = false;
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      if (visible()) everShown = true;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);

    stalled = true;
    await wait(60);
    stalled = false;
    await wait(250);
    sampling = false;
    expect(everShown).toBe(false);
    expect(visible()).toBe(false);
  });
});
