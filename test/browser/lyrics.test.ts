/**
 * Lyrics in the real UI (headless Chrome, React shell, test services with the fake engine): the lyrics lane above the
 * playlist (typing a word makes one undo step), the Lyrics window (an empty state, then karaoke that lights the word
 * being sung), and no React commits while the song plays with the window open.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { page } from 'vitest/browser';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { placeLyricWords } from '@core/ops/lyrics';
import { lyricsSorted } from '@core/query/lyrics';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

// A passing wait ends as soon as the condition holds; the generous limit only matters on a machine so busy that React takes seconds.
const until = async (ok: () => boolean, ms = 30_000) => {
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

describe('lyrics (UI)', { timeout: 120_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let commits = 0;
  const errors: unknown[] = [];
  const lyricsWindow = () => host.querySelector<HTMLElement>('[data-window-type="lyrics"]');
  const lane = () => host.querySelector<HTMLCanvasElement>('canvas[data-hint^="Lyrics lane"]');
  const words = () => [...(lyricsWindow()?.querySelectorAll<HTMLElement>('[data-w]') ?? [])];
  const lit = () => words().findIndex((w) => /now/.test(w.className));
  const sung = () => words().filter((w) => /sung/.test(w.className)).length;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    host.id = 'root';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    s.editor.getState().setPlaylist({ pxPerTick: 0.05, scrollTick: 0, scrollLane: 0 });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'playlist');
    root = createRoot(host);
    root.render(
      createElement(Profiler, { id: 'app', onRender: () => void commits++ }, createElement(ServicesProvider, { services: s, children: createElement(App) })),
    );
    await until(() => !!host.querySelector('[data-window-type="playlist"]'));
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    vi.restoreAllMocks();
  });

  it('shows the lyrics lane when asked, and typing a word on it is one undo step', async () => {
    expect(lane()).toBeNull();
    await s.commands.run('lyrics.showLane');
    await until(() => !!lane());
    const steps = s.history.steps().done.length;
    const box = lane()!.getBoundingClientRect();
    await userEvent.click(lane()!, { position: { x: 200, y: box.height / 2 } });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Lyric word"]')!;
    await until(() => input.style.display === 'block');
    await userEvent.keyboard('beau-ti-ful{Enter}');
    await until(() => lyricsSorted(s.doc.getState().project).length === 3);
    expect(lyricsSorted(s.doc.getState().project).map((w) => w.text)).toEqual(['beau', 'ti', 'ful']);
    expect(s.history.steps().done.length).toBe(steps + 1);
    s.history.undo();
    expect(s.doc.getState().project.lyrics).toBeUndefined();
  });

  it('the Lyrics window explains itself while empty, then shows the lines', async () => {
    openWindow(s, 'lyrics');
    await until(() => !!lyricsWindow() && lyricsWindow()!.textContent!.includes('No lyrics yet'));
    expect(lyricsWindow()!.textContent).toContain('Paste lyrics…');
    s.history.transact('Lyrics', (d) => {
      const placed = Array.from({ length: 24 }, (_, i) => ({ tick: i * 60, length: 60, text: `w${i}`, line: Math.floor(i / 6) }));
      placeLyricWords(d, placed);
    });
    await until(() => words().length === 24);
    expect(lyricsWindow()!.querySelectorAll('[data-line]')).toHaveLength(4);
  });

  it('lights the word being sung and the words before it, from the song position', async () => {
    s.view.getState().setMode('song');
    s.view.getState().setSongStart(60 * 7 + 10);
    await until(() => lit() === 7);
    expect(sung()).toBe(7);
    s.view.getState().setSongStart(0);
    await until(() => lit() === 0);
    expect(sung()).toBe(0);
  });

  it('follows playback with no React commits, and the lit word moves on', async () => {
    s.view.getState().setSongStart(0);
    await until(() => lit() === 0);
    s.fakeEngine.startTick = 0;
    s.engine.play();
    await frames(5);
    const before = commits;
    const first = lit();
    await frames(40);
    expect(commits).toBe(before);
    expect(lit()).toBeGreaterThan(first);
    s.engine.stop();
  });

  it('logged no errors', () => {
    expect(errors).toEqual([]);
  });
});
