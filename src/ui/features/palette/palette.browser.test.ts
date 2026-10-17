/**
 * The action search keeps only the rows near the viewport in the DOM (it can list 80): moving the choice with the
 * arrow keys scrolls to it, the input's aria-activedescendant always names a row that exists, and Enter runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { registerFeatures } from '@ui/features';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { paletteStore, togglePalette } from './Palette';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe('action search (UI)', { timeout: 30_000 }, () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    const s = createTestServices();
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await frames(3);
  });

  afterAll(() => {
    if (paletteStore.getState().open) togglePalette();
    root.unmount();
    host.remove();
  });

  const input = () => document.querySelector<HTMLInputElement>('input[aria-controls="ag-palette-list"]')!;
  const rows = () => [...document.querySelectorAll<HTMLElement>('#ag-palette-list [role="option"]')];

  it('draws a window of the rows, and the arrow keys scroll the choice into view', async () => {
    togglePalette();
    await frames(3);
    expect(rows().length).toBeGreaterThan(5);
    expect(rows().length).toBeLessThan(40);
    const list = document.getElementById('ag-palette-list')!;
    for (let i = 0; i < 60; i++) {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await frames(1);
      const id = input().getAttribute('aria-activedescendant');
      const row = document.getElementById(id ?? '');
      expect(row, `row ${i + 1} (${id}) is in the DOM`).not.toBeNull();
      const r = row!.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      expect(r.top, `row ${i + 1} is below the top of the list`).toBeGreaterThanOrEqual(l.top - 1);
      expect(r.bottom, `row ${i + 1} is above the bottom of the list`).toBeLessThanOrEqual(l.bottom + 1);
    }
    expect(rows().length).toBeLessThan(40);
    expect(list.scrollTop).toBeGreaterThan(0);
  });

  it('typing narrows the rows and puts the choice back at the top', async () => {
    const el = input();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, 'metronome');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await frames(3);
    const list = document.getElementById('ag-palette-list')!;
    expect(list.scrollTop).toBe(0);
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(rows()[0]?.textContent).toMatch(/metronome/i);
  });
});
