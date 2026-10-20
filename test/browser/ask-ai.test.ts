/**
 * "Ask Studio about this part" in the real UI (headless Chrome, React shell, test services with the fake
 * engine, so nothing sounds and nothing reaches Claude): the playlist's Studio mark pill, a marker's Studio mark, the Ask
 * AI card (typing in it plays no notes, Esc and outside clicks), Studio's part chip, and no
 * React commits while the song plays with the card closed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import type { MarkerId, PatternClip } from '@core/model/types';
import { registerFeatures } from '@ui/features';
import { anchorBox } from '@ui/features/ask-ai/anchors';
import { askAboutMarker, askStore, closeAsk } from '@ui/features/ask-ai/ask-state';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY, untilStill } from '../helpers/wait';

const BAR = 3840;
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

describe('Ask Studio about this part (UI)', () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let commits = 0;
  const errors: unknown[] = [];
  const card = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Ask Studio about this part"]');
  const pill = () => host.querySelector<HTMLElement>('[aria-label="Ask Studio about this part"]');
  const marker = (name: string) =>
    Object.values(s.doc.getState().project.playlist.markers).find((m) => m.name === name)!.id as MarkerId;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    host.id = 'root';
    document.body.append(host);
    s = createTestServices();
    s.history.transact('song', (d) => void buildStackedSong(d));
    s.history.load(s.doc.getState().project);
    // Nothing reaches Claude from here: the assistant stays offline.
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true, typingPiano: true });
    // The whole song fits: a bar is 23 px.
    s.editor.getState().setPlaylist({ pxPerTick: 0.006, scrollTick: 0, scrollLane: 0 });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'playlist');
    s.view.getState().setMaximized('playlist', true);
    root = createRoot(host);
    root.render(
      createElement(Profiler, { id: 'app', onRender: () => void commits++ }, createElement(ServicesProvider, { services: s, children: createElement(App) })),
    );
    await until(() => !!pill());
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    vi.restoreAllMocks();
  });

  it('shows Studio mark Ask Studio over the selected clips, a compact Studio mark for one clip, and over the loop region', async () => {
    const p = s.doc.getState().project;
    const intro = (Object.values(p.playlist.clips) as PatternClip[])
      .filter((c) => c.kind === 'pattern' && p.patterns[c.patternId]?.name === 'Intro' && c.start < 4 * BAR && c.laneId === p.playlist.laneOrder[0])
      .sort((a, b) => a.start - b.start);
    expect(pill()!.style.display).toBe('none');
    s.editor.getState().selectClips(intro.map((c) => c.id));
    await frames(2);
    expect(pill()!.style.display).not.toBe('none');
    expect(pill()!.textContent).toBe('Ask Studio');
    expect(pill()!.getAttribute('data-hint')).toBe('Ask Studio to change the 2 selected clips (bars 1–4), Alt+A: only they change');
    // Above the selection's top-right corner, inside the grid.
    const grid = host.querySelector('[data-window-type="playlist"]')!.getBoundingClientRect();
    const r = pill()!.getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(grid.left);
    expect(r.right).toBeLessThanOrEqual(grid.right);
    s.editor.getState().selectClips([intro[0]!.id]);
    await frames(2);
    await expect.poll(() => pill()!.textContent, EVENTUALLY).toBe('');
    expect(pill()!.querySelector('svg')).not.toBeNull();
    s.editor.getState().selectClips([]);
    s.view.getState().setLoop({ start: 8 * BAR, end: 16 * BAR });
    await frames(2);
    await expect.poll(() => pill()!.textContent, EVENTUALLY).toBe('Ask Studio');
    expect(pill()!.getAttribute('data-hint')).toBe('Ask Studio to change Pre-verse (bars 9–16), Alt+A: only those bars change');
    // Clicking it opens the card about that section.
    await userEvent.click(pill()!);
    await until(() => !!card());
    expect(askStore.getState().focus).toMatchObject({ kind: 'section', markerId: marker('Pre-verse') });
    expect(card()!.textContent).toContain('Pre-verse · bars 9–16');
    closeAsk();
    await until(() => !card());
    s.view.getState().setLoop(null);
  });

  it('a marker’s Studio mark loops its section and opens the card on the flag; the name still jumps', async () => {
    const verse = marker('Verse');
    const flag = anchorBox({ kind: 'marker', markerId: verse })!;
    expect(flag).toBeTruthy();
    const ruler = host.querySelector<HTMLCanvasElement>('canvas[data-hint^="Drag to set a loop region"]')!;
    const rr = ruler.getBoundingClientRect();
    // On the Studio mark (the flag's last 15 px).
    await userEvent.click(ruler, { position: { x: flag.right - rr.left - 7, y: flag.top - rr.top + 7 } });
    await until(() => !!card());
    expect(s.view.getState().loop).toEqual({ start: 16 * BAR, end: 32 * BAR });
    expect(askStore.getState().focus).toMatchObject({ kind: 'section', markerId: verse });
    expect(card()!.textContent).toContain('Verse · bars 17–32');
    expect(card()!.textContent).toContain('Smooth the transition in');
    // The card sits next to the flag.
    const c = card()!.getBoundingClientRect();
    expect(c.top).toBeGreaterThanOrEqual(flag.bottom);
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    closeAsk();
    await until(() => !card());
    // The name jumps to the marker (song position), it doesn't open the card.
    s.view.getState().setSongStart(0);
    await userEvent.click(ruler, { position: { x: flag.left - rr.left + 8, y: flag.top - rr.top + 7 } });
    await frames(2);
    await expect.poll(() => s.view.getState().songStart, EVENTUALLY).toBe(16 * BAR);
    expect(card()).toBeNull();
  });

  it('typing in the card plays no notes; Esc closes it; an outside click closes it only when empty', async () => {
    const spy = vi.spyOn(s.fakeEngine, 'previewNoteOn');
    askAboutMarker(s, marker('Drop'));
    await until(() => !!card() && document.activeElement?.tagName === 'TEXTAREA');
    await userEvent.keyboard('zxcv more bounce');
    const box = card()!.querySelector('textarea')!;
    expect(box.value).toBe('zxcv more bounce');
    expect(spy).not.toHaveBeenCalled();
    // Half typed: a click elsewhere leaves it open.
    await userEvent.click(host.querySelector('header')!, { position: { x: 600, y: 20 } });
    expect(card()).not.toBeNull();
    box.focus();
    await userEvent.keyboard('{Escape}');
    await until(() => !card());
    // Outside the card the same keys play the typing keyboard (so the check above means something).
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('z');
    expect(spy).toHaveBeenCalled();
    // Empty: a click elsewhere closes it.
    askAboutMarker(s, marker('Drop'));
    await until(() => !!card());
    await userEvent.click(host.querySelector('header')!, { position: { x: 600, y: 20 } });
    await until(() => !card());
    spy.mockRestore();
  });

  it('asks from the card: without an AI it says so, and Studio shows the part as a chip', async () => {
    askAboutMarker(s, marker('Verse'));
    await until(() => !!card());
    await userEvent.keyboard('add a fill at the end{Enter}');
    await until(() => (card()?.textContent ?? '').includes('needs an AI'));
    expect(card()!.textContent).toContain('add a fill at the end');
    expect(card()!.textContent).toContain('About Verse · bars 17–32');
    closeAsk();
    // The conversation keeps the part: Studio shows it, ▶ plays it, × lets it go.
    openWindow(s, 'assistant');
    // The Studio window's code loads on first use.
    await until(() => host.textContent!.includes('Smooth the transition in'));
    await until(() => host.textContent!.includes('About Verse · bars 17–32'));
    const chipClear = host.querySelector<HTMLElement>('[aria-label="Ask about the whole song"]')!;
    expect(host.textContent).toContain('Smooth the transition in');
    await userEvent.click(chipClear);
    await until(() => !host.querySelector('[aria-label="Ask about the whole song"]'));
    expect(s.assistant.store.getState().focus).toBeNull();
    s.view.getState().hideWindow('assistant');
  });

  it('makes no React commits while the song plays with the card closed', async () => {
    closeAsk();
    s.view.getState().setMode('song');
    s.engine.play(0);
    await untilStill(() => commits);
    const before = commits;
    await frames(30);
    await expect.poll(() => commits, EVENTUALLY).toBe(before);
    s.engine.stop();
  });

  it('logged no errors', () => {
    expect(errors).toEqual([]);
  });
});
