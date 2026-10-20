/**
 * The Export dialog's video side in the real React tree: every control has a name and a hint, the tabs and
 * the range work, the choices are remembered, the preview shows a real picture, a plain message appears when a
 * format is not available, and no text says "AI" (the product says "Studio").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServices, type Services } from '@app/services';
import { registerFeatures } from '@ui/features';
import { exportStore, openExport } from '@ui/features/export/export-store';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import { page } from 'vitest/browser';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="ag-export-title"]');
const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const nameOf = (el: Element): string => {
  const h = el as HTMLInputElement;
  return (
    el.getAttribute('aria-label')?.trim() ||
    [...(h.labels ?? [])]
      .map((l) => l.textContent ?? '')
      .join(' ')
      .trim() ||
    (el.textContent ?? '').trim() ||
    (el.getAttribute('title') ?? el.getAttribute('placeholder') ?? '').trim()
  );
};
const hasHint = (el: Element) =>
  !!el.closest('[data-hint]') || !!el.getAttribute('aria-label') || !!el.getAttribute('title');

describe('Export dialog: video', () => {
  let s: Services;
  let root: Root;
  let host: HTMLDivElement;

  beforeAll(async () => {
    host = document.createElement('div');
    await page.viewport(1440, 900);
    host.style.cssText = 'position:fixed;inset:0';
    host.id = 'root';
    document.body.append(host);
    s = createServices();
    registerFeatures(s);
    applyDefaultLayout(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    await frame();
  });

  afterAll(async () => {
    exportStore.setState({ open: false });
    root.unmount();
    host.remove();
    await s.engine.dispose();
  });

  it('File > Export as video opens the dialog on its video tab; the Audio tab goes back', async () => {
    expect(s.commands.get('file.exportVideo')).toBeTruthy();
    await s.commands.run('file.exportVideo');
    await until(() => !!dialog());
    const d = dialog()!;
    expect(d.querySelector('h2')!.textContent).toBe('Export as video');
    expect(d.textContent).toContain('Export video…');
    const tabs = [...d.querySelectorAll<HTMLElement>('[aria-label="What to export"] [role="radio"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Audio', 'Video']);
    expect(tabs[1]!.getAttribute('aria-checked')).toBe('true');
    tabs[0]!.click();
    await frame();
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Export audio');
    expect(dialog()!.textContent).toContain('File format');
    expect(dialog()!.textContent).not.toContain('Export video…');
    tabs[1]!.click();
    await frame();
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Export as video');
  });

  it('every control has a name and a hint, and nothing says "AI"', async () => {
    openExport('video');
    await frame();
    const d = dialog()!;
    const controls = [...d.querySelectorAll('button, input:not([type="file"]), select')].filter(visible);
    expect(controls.length).toBeGreaterThan(14);
    const unnamed = controls.filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 80));
    const noHint = controls.filter((el) => !hasHint(el)).map((el) => `${el.tagName} ${nameOf(el)}`);
    expect(unnamed).toEqual([]);
    expect(noHint).toEqual([]);
    expect(/\bA\.?I\.?\b/.test(d.textContent ?? '')).toBe(false);
    // Hints say what the control does in words, with units where there are some.
    const fps = [...d.querySelectorAll('[data-hint]')].find((e) => e.textContent?.startsWith('Frame rate'))!;
    expect(fps.getAttribute('data-hint')).toMatch(/per second/);
  });

  it('shows a real preview that changes with the look, and remembers the choices', async () => {
    openExport('video');
    await frame();
    const canvas = () => dialog()!.querySelector<HTMLCanvasElement>('canvas[aria-label^="Preview"]')!;
    const stats = () => {
      const c = canvas();
      const g = c.getContext('2d')!;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let sq = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const v = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        sum += v;
        sq += v * v;
      }
      const mean = sum / n;
      return { w: c.width, h: c.height, mean, sd: Math.sqrt(sq / n - mean * mean) };
    };
    const pick = async (group: string, label: string) => {
      const b = [...dialog()!.querySelectorAll<HTMLElement>(`[aria-label="${group}"] [role="radio"]`)].find(
        (x) => x.textContent === label,
      )!;
      b.click();
      await frame();
      await frame();
    };
    await pick('Picture shape', 'Widescreen');
    const wide = stats();
    expect(wide.w).toBe(480);
    expect(wide.h).toBe(270);
    expect(wide.sd).toBeGreaterThan(8);
    await pick('Picture shape', 'Vertical');
    const tall = stats();
    expect([tall.w, tall.h]).toEqual([270, 480]);
    await pick('Picture shape', 'Square');
    expect([stats().w, stats().h]).toEqual([270, 270]);
    expect(s.prefs.getState().exportVideoSize).toBe('square');
    for (const [label, style] of [
      ['Waveform', 'wave'],
      ['Circle', 'circle'],
      ['Minimal', 'minimal'],
      ['Bars', 'bars'],
    ] as const) {
      await pick('Picture style', label);
      expect(s.prefs.getState().exportVideoStyle).toBe(style);
      expect(stats().sd, label).toBeGreaterThan(8);
    }
    await pick('Picture shape', 'Widescreen');
    // The title is drawn on the picture: changing it changes the pixels.
    const before = canvas().toDataURL();
    const title = dialog()!.querySelector<HTMLInputElement>('input[placeholder="Song title"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(title, 'A totally different title');
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    await frame();
    expect(canvas().toDataURL()).not.toBe(before);
  });

  it('says in plain words when a format is not available here, and keeps Export off', async () => {
    openExport('video');
    await until(() => !!dialog()?.querySelector('select option'));
    const d = dialog()!;
    const select = [...d.querySelectorAll('select')].find((e) =>
      [...e.options].some((o) => o.textContent?.includes('MP4')),
    )!;
    // Chrome here can make all three; the dialog lists them with their names.
    const names = [...select.options].map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('MP4 (H.264)'))).toBe(true);
    expect(names.some((n) => n.includes('WebM (VP9)'))).toBe(true);
    expect(names.some((n) => n.includes('WebM (AV1)'))).toBe(true);
    // A fake browser without WebCodecs: the note says so and Export is disabled.
    const real = globalThis.VideoEncoder;
    // @ts-expect-error simulating a browser without WebCodecs
    delete globalThis.VideoEncoder;
    try {
      exportStore.setState({ open: false });
      await frame();
      openExport('video');
      await until(() => !!dialog());
      await until(() => /cannot make videos/.test(dialog()!.textContent ?? ''));
      const go = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === 'Export video…',
      )!;
      expect(go.disabled).toBe(true);
      expect(dialog()!.textContent).toContain('WebCodecs');
    } finally {
      globalThis.VideoEncoder = real;
    }
  });

  it('opened from a part of the song, the range offers that part first', async () => {
    exportStore.setState({ open: false });
    await frame();
    openExport('video', { from: 3840, to: 7680, label: '“Verse” (bar 2)' });
    await until(() => !!dialog());
    const labels = [...dialog()!.querySelectorAll('input[name="range"]')].map(
      (i) => i.closest('label')!.textContent ?? '',
    );
    expect(labels[0]).toContain('“Verse” (bar 2)');
    expect((dialog()!.querySelector('input[name="range"]') as HTMLInputElement).checked).toBe(true);
  });
});
