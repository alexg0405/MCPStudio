/**
 * A big DJ library keeps only the rows near the viewport in the DOM (the table is windowed); a short one renders whole,
 * and the scroll height stays that of every row, so the scrollbar is honest and the last song can be reached.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { library, type LibrarySong } from '@app/dj/library';
import { createTestServices } from '@app/testing';
import { ServicesProvider } from '@ui/services-context';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { DjWindow } from './DjWindow';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

const song = (i: number): LibrarySong => ({
  key: `song-${i}`,
  ref: { id: `ref-${i}`, name: `Song ${i}`, source: { kind: 'embedded', hash: `h${i}`, bytes: 1 } } as unknown as LibrarySong['ref'],
  title: `Song ${i}`,
  label: `Song ${i}`,
  fileName: `song-${i}.mp3`,
  durationSec: 180,
  addedAt: i,
});

describe('DJ library table (UI)', { timeout: 30_000 }, () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:520px;display:flex;flex-direction:column';
    document.body.append(host);
    const s = createTestServices();
    library.setState({ songs: Array.from({ length: 400 }, (_, i) => song(i)), loaded: true, selected: [] });
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(DjWindow) }));
    await frames(4);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    library.setState({ songs: [], selected: [] });
  });

  const wrap = () => host.querySelector<HTMLElement>('[class*="tableWrap"]')!;
  const bodyRows = () => [...host.querySelectorAll<HTMLElement>('tbody tr:not([aria-hidden])')];

  it('draws a window of 400 songs, and every row is reachable by scrolling', async () => {
    expect(bodyRows().length).toBeGreaterThan(5);
    expect(bodyRows().length).toBeLessThan(80);
    expect(bodyRows()[0]!.textContent).toContain('Song 0');
    // The scroll height is that of all rows (30 px each, plus the header).
    expect(wrap().scrollHeight).toBeGreaterThan(400 * 30);
    expect(wrap().scrollHeight).toBeLessThan(400 * 30 + 60);
    wrap().scrollTop = wrap().scrollHeight;
    await frames(3);
    expect(bodyRows().length).toBeLessThan(80);
    expect(bodyRows().at(-1)!.textContent).toContain('Song 399');
    wrap().scrollTop = 150 * 30;
    await frames(3);
    const first = bodyRows()[0]!;
    const top = first.getBoundingClientRect().top - wrap().getBoundingClientRect().top;
    // Rows sit where the spacer says: the window has the rows in view.
    const inView = bodyRows().filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > wrap().getBoundingClientRect().top + 30 && b.top < wrap().getBoundingClientRect().bottom;
    });
    expect(inView.length).toBeGreaterThan(5);
    expect(inView[0]!.textContent).toMatch(/Song (14\d|15\d)/);
    void top;
  });

  it('a short library renders every row', async () => {
    library.setState({ songs: Array.from({ length: 12 }, (_, i) => song(i)) });
    await frames(3);
    expect(bodyRows().length).toBe(12);
  });
});
