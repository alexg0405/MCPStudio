/**
 * The menu bar's submenus (headless Chrome, the real React shell, test services with the fake engine):
 * Options → Theme opens right beside its row, not offset by the Options panel's position (the panel's
 * backdrop blur makes it the containing block of the fixed submenu), and stays there once the panel's
 * float-in has finished. The keyboard opens it in the same place.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const until = async (ok: () => boolean, ms = 5000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 16));
  }
};

describe('the menu bar’s submenus (UI)', { timeout: 30_000 }, () => {
  let root: Root;
  let host: HTMLDivElement;
  const menus = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
  const optionsLabel = () => host.querySelector<HTMLElement>('[data-menu="options"]')!;
  const themeRow = () =>
    [...(menus()[0]?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find((b) => b.textContent === 'Theme');
  /** The Theme submenu is open and placed. */
  const subPlaced = () => menus().length === 2 && menus()[1]!.style.visibility !== 'hidden';
  const expectBesideRow = () => {
    const row = themeRow()!.getBoundingClientRect();
    const sr = menus()[1]!.getBoundingClientRect();
    expect(Math.abs(sr.left - row.right)).toBeLessThan(2);
    expect(Math.abs(sr.top - (row.top - 5))).toBeLessThan(2);
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    const s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-menu="options"]'));
  });

  beforeEach(async () => {
    if (menus().length) {
      await userEvent.keyboard('{Escape}');
      await until(() => !menus().length);
    }
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('Options → Theme opens right beside its row, and stays there', async () => {
    await userEvent.click(optionsLabel());
    await until(() => !!themeRow());
    await userEvent.hover(themeRow()!);
    await until(subPlaced);
    expect(menus()[1]!.textContent).toMatch(/Marble/i);
    expectBesideRow();
    // After the Options panel's float-in (and the submenu's fade) are over.
    await new Promise((r) => setTimeout(r, 400));
    expectBesideRow();
    expect(getComputedStyle(menus()[1]!).animationName).not.toMatch(/float/);
  });

  it('opened from the keyboard, it lands in the same place', async () => {
    optionsLabel().focus();
    await userEvent.keyboard('{Enter}');
    await until(() => !!themeRow());
    themeRow()!.focus();
    await userEvent.keyboard('{ArrowRight}');
    await until(subPlaced);
    expectBesideRow();
    await until(() => !!menus()[1]!.contains(document.activeElement));
  });
});
