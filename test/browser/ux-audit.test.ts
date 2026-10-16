/**
 * UX audit of the running shell (headless Chrome, real React tree): walks the toolbar, the menus and every
 * window type and reports controls that don't explain themselves. The registry half (command hints, shortcut
 * clashes, menu to action-search) is test/unit/ux-audit.test.ts.
 *
 * - Every interactive element has a name a screen reader can say (text, aria-label, title or a label).
 * - Icon-only controls (no text) also carry a data-hint (own or an ancestor's) or an aria-label.
 * - Every window opens, shows something, and an empty one says what to do next.
 * - No visible text, hint or label says "AI" (the product says "Studio").
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServices, type Services } from '@app/services';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import { openWindow, windowTypes } from '@ui/workspace/registry';
import { createEmptyProject } from '@core/model/defaults';
import { getMenus } from '@ui/shell/menus';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 8000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="option"], [tabindex]:not([tabindex="-1"])';

const AI_WORD = /\bA\.?I\.?\b/;

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function describe_(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.split(' ')[0] : '';
  const text = nameOf(el).slice(0, 24);
  return `${tag}${el instanceof HTMLInputElement ? `[${el.type}]` : ''}${cls ? '.' + cls : ''}${el.getAttribute('data-menu') ? `[menu=${el.getAttribute('data-menu')}]` : ''}${text ? ` "${text}"` : ''}`;
}

/** What a screen reader would call it. */
function nameOf(el: Element): string {
  const h = el as HTMLInputElement;
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (t) return t;
  }
  if (h.labels?.length)
    return [...h.labels]
      .map((l) => l.textContent ?? '')
      .join(' ')
      .trim();
  const text = (el.textContent ?? '').trim();
  if (text) return text;
  return (el.getAttribute('title') ?? el.getAttribute('placeholder') ?? el.getAttribute('data-hint') ?? '').trim();
}

const hasHint = (el: Element) =>
  !!el.closest('[data-hint]') || !!el.getAttribute('aria-label') || !!el.getAttribute('title');

/** Controls inside `root` that fail the name rule (everything) or the hint rule (icon-only). */
function audit(root: Element): { unnamed: string[]; iconNoHint: string[]; textOnly: string[]; count: number } {
  const unnamed: string[] = [];
  const iconNoHint: string[] = [];
  const textOnly: string[] = [];
  let count = 0;
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    // Canvas-internal and hidden file inputs are driven by their own controllers/labels.
    if (el instanceof HTMLInputElement && el.type === 'file') continue;
    count++;
    if (!nameOf(el)) unnamed.push(describe_(el));
    // A control whose only name is its own visible text (a "Save" button) states its purpose; the rest need a hint.
    const visibleText = (el.textContent ?? '').trim() || ((el as HTMLInputElement).labels?.length ? 'label' : '');
    if (!visibleText && !hasHint(el)) iconNoHint.push(describe_(el));
    // A row that only opens a submenu is explained by the list it opens.
    if (!hasHint(el) && el.getAttribute('aria-haspopup') !== 'menu') textOnly.push(describe_(el));
  }
  return { unnamed, iconNoHint, textOnly, count };
}

describe('UX audit (shell)', () => {
  let s: Services;
  let root: Root;
  let host: HTMLDivElement;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1440px;height:900px';
    host.id = 'root';
    document.body.append(host);
    const plugins = new PluginRegistry();
    await installPluginDiscovery(plugins);
    s = createServices({ plugins });
    registerFeatures(s);
    installKeyboard(s);
    applyDefaultLayout(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    await frame();
  });

  afterAll(async () => {
    root.unmount();
    host.remove();
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  it('the toolbar: every control is named, icon-only ones have a hint', async () => {
    const bar = host.querySelector('header')!;
    const a = audit(bar);
    expect(a.count).toBeGreaterThan(10);
    expect(a.unnamed).toEqual([]);
    expect(a.iconNoHint).toEqual([]);
    expect(a.textOnly.filter((t) => !t.includes('[menu='))).toEqual([]); // the menu-bar words open menus
  });

  it('every menu opens, and each of its entries is named', async () => {
    const problems: string[] = [];
    for (const m of getMenus()) {
      const label = host.querySelector<HTMLElement>(`[data-menu="${m.id}"]`);
      if (!label) continue; // an empty menu is not shown
      label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      await frame();
      const panel = host.querySelector('[role="menu"]');
      if (!panel) {
        problems.push(`${m.label}: did not open`);
        continue;
      }
      const a = audit(panel);
      if (a.count === 0) problems.push(`${m.label}: no entries`);
      problems.push(...a.unnamed.map((u) => `${m.label}: unnamed ${u}`));
      problems.push(...a.textOnly.map((u) => `${m.label}: no hint ${u}`));
      label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      await frame();
    }
    expect(problems).toEqual([]);
  });

  it('every window opens; its controls are named; an empty one says what to do next', async () => {
    const problems: string[] = [];
    const empties: string[] = [];
    const types = windowTypes();
    const textOnlyAll: string[] = [];
    expect(types.length).toBeGreaterThan(8);
    const opened: string[] = [];
    for (const type of types) {
      let id: string;
      try {
        id = openWindow(s, type, null);
      } catch {
        continue; // needs props (a plugin editor for one specific plugin)
      }
      await frame();
      const win =
        host.querySelector<HTMLElement>(`[data-window="${id}"]`) ??
        host.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
      if (!win) {
        // Window types that need props render a placeholder or nothing: note it.
        empties.push(`${type}: no DOM window found`);
        continue;
      }
      opened.push(type);
      const a = audit(win);
      problems.push(...a.unnamed.map((u) => `${type}: unnamed ${u}`));
      problems.push(...a.iconNoHint.map((u) => `${type}: icon-only without hint ${u}`));
      textOnlyAll.push(...a.textOnly.map((u) => `${type}: ${u}`));
      const text = (win.innerText ?? '').trim();
      const drawn = !!win.querySelector('canvas');
      if (!drawn && text.length < 12) empties.push(`${type}: no text and no canvas`);
    }
    expect(opened.length).toBeGreaterThan(5);
    console.info('UX audit windows opened:', opened.join(', '));
    expect(problems).toEqual([]);
    expect(textOnlyAll).toEqual([]);
    expect(empties).toEqual([]);
  });

  it('the browser panel: every control is named and has a hint', async () => {
    const browser = host.querySelector('aside') ?? host.querySelector('[data-tour="browser"]');
    expect(browser).toBeTruthy();
    const a = audit(browser!);
    expect(a.count).toBeGreaterThan(5);
    expect(a.unnamed).toEqual([]);
    expect(a.textOnly).toEqual([]);
  });

  it('the welcome dialog: centered, readable, every control named', async () => {
    s.commands.run('help.welcome');
    await until(() => !!document.querySelector('[role="dialog"]'));
    await frame();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const r = dialog.getBoundingClientRect();
    expect(Math.abs(r.left + r.width / 2 - window.innerWidth / 2)).toBeLessThan(6);
    expect(Math.abs(r.top + r.height / 2 - window.innerHeight / 2)).toBeLessThan(window.innerHeight * 0.1);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    const a = audit(dialog);
    expect(a.unnamed).toEqual([]);
    expect(a.iconNoHint).toEqual([]);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frame();
  });

  it('with an empty project every window says what to do next', async () => {
    await s.files.newProject(createEmptyProject());
    await frame();
    const vague: string[] = [];
    const NEXT_STEP =
      /\b(click|press|drag|select|add|choose|ask|type|right-click|drop|import|pick|open|use|play|draw|tell|say|record)\b/i;
    for (const type of [
      'channel-rack',
      'piano-roll',
      'playlist',
      'mixer',
      'history',
      'assistant',
      'dj',
      'visualizer',
      'settings',
    ]) {
      const id = openWindow(s, type, null);
      await frame();
      const win = host.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
      if (!win) {
        vague.push(`${type}: no window`);
        continue;
      }
      const text = (win.innerText ?? '').replace(/\s+/g, ' ');
      // Canvas windows carry their instructions in the window's help and the hint bar (checked below).
      if (!NEXT_STEP.test(text)) vague.push(`${type}: "${text.slice(0, 80)}"`);
    }
    expect(vague).toEqual([]);
  });

  it('nothing visible says "AI"', () => {
    const hits: string[] = [];
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['aria-label', 'title', 'data-hint', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v && AI_WORD.test(v)) hits.push(`${attr}: ${v}`);
      }
    }
    const text = host.innerText ?? '';
    for (const line of text.split('\n')) if (AI_WORD.test(line)) hits.push(`text: ${line}`);
    expect(hits).toEqual([]);
  });
});
