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
import { addInstrumentChannel } from '@app/actions/channels';
import { addEffect, addMixerInsert } from '@app/actions/mixer';
import { TOUR } from '@ui/features/help/tour';
import { LESSONS } from '@ui/features/help/lessons';
import { page } from 'vitest/browser';
import { createEmptyProject } from '@core/model/defaults';
import { getMenus } from '@ui/shell/menus';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 30_000, what = 'a condition') => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
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
  return (el.getAttribute('title') ?? el.getAttribute('placeholder') ?? '').trim();
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
    await page.viewport(1440, 900);
    host.style.cssText = 'position:fixed;inset:0';
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

  it('the toolbar never clips: at every width what does not fit moves into More', async () => {
    const header = host.querySelector('header')!;
    // With audio running the toolbar shows the sample rate and delay instead of the "click to enable" chip.
    await s.engine.resume();
    await until(() => s.engine.state === 'running');
    await frame();
    const slotsLeft = new Set<string>();
    for (const [w, h] of [
      [1440, 900],
      [1280, 800],
      [1100, 760],
      [1000, 700],
      [800, 600],
    ] as const) {
      await page.viewport(w, h);
      await frame();
      await frame();
      // Nothing in the bar sticks out past the window's right edge.
      const out = [...header.querySelectorAll<HTMLElement>('button, [data-slot]')]
        .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > w + 1)
        .map((el) => `${w}px: ${describe_(el)} ends at ${Math.round(el.getBoundingClientRect().right)}`);
      expect(out).toEqual([]);
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
      // The Studio button and the transport are always on screen; the window buttons are in the bar or in More.
      expect(header.querySelector('[data-tour="assistant"]')).toBeTruthy();
      expect(header.querySelector('[data-tour="transport"]')).toBeTruthy();
      const more = header.querySelector('[aria-label="More toolbar controls"]');
      const windows = header.querySelector('[data-tour="windows"]');
      expect(!!more || !!windows).toBe(true);
      slotsLeft.add(more ? 'more' : 'all');
    }
    expect(slotsLeft.has('more')).toBe(true); // the narrow widths did overflow
    await page.viewport(1440, 900);
    await frame();
  });

  it('the compact transport: narrow bars shrink the displays and show bar:step (a click shows the ticks); every control stays reachable', async () => {
    const header = host.querySelector('header')!;
    const root = document.documentElement;
    const was = root.dataset.theme;
    const time = () => header.querySelector<HTMLButtonElement>('[aria-label="Song position"]')!;
    /** What the position readout shows right now (the hidden form is not counted). */
    const timeText = () =>
      [...time().querySelectorAll('span')]
        .filter((el) => visible(el) && /^\d+:\d\d/.test(el.textContent ?? ''))
        .map((el) => el.textContent);
    const transportParts = () =>
      [
        header.querySelector<HTMLElement>('[data-tour="transport"] button[class*="modeSwitch"]'),
        header.querySelector<HTMLElement>('[aria-label="Play"], [aria-label="Pause"], [aria-label^="Play"]'),
        header.querySelector<HTMLElement>('[aria-label="Stop"]'),
        header.querySelector<HTMLElement>('[aria-label^="Record"]'),
        header.querySelector<HTMLElement>('[aria-label="Metronome"]'),
        header.querySelector<HTMLElement>('[data-tour="tempo"]'),
        time(),
      ] as const;
    const widthOf = new Map<string, number>();
    try {
      for (const theme of ['marble', 'carrara']) {
        if (theme === 'marble') delete root.dataset.theme;
        else root.dataset.theme = theme;
        for (const w of [1280, 1000, 800]) {
          await page.viewport(w, 700);
          await frame();
          await frame();
          if (time().hasAttribute('data-expanded')) time().click();
          await frame();
          const bar = header.querySelector<HTMLElement>('[data-tour="transport"]')!;
          widthOf.set(`${theme}@${w}`, bar.getBoundingClientRect().width);
          // Every part of the transport is there, on screen, and its text is not cut off.
          for (const part of transportParts()) {
            expect(part, `${theme}@${w}: a transport control is missing`).toBeTruthy();
            const r = part!.getBoundingClientRect();
            expect(r.width, `${theme}@${w}: ${part!.className}`).toBeGreaterThan(0);
            expect(r.right, `${theme}@${w}: ${part!.className} past the window`).toBeLessThanOrEqual(w);
          }
          for (const el of header.querySelectorAll<HTMLElement>('[data-tour="transport"] [class*="lcdValue"]'))
            if (visible(el)) expect(el.scrollWidth, `${theme}@${w}: "${el.textContent}" is cut off`).toBeLessThanOrEqual(el.clientWidth + 1);
          if (w >= 1280) {
            expect(timeText(), `${theme}@${w}`).toEqual(['1:01:000']);
          } else {
            expect(timeText(), `${theme}@${w}`).toEqual(['1:01']);
            time().click();
            await frame();
            expect(timeText(), `${theme}@${w} after a click`).toEqual(['1:01:000']);
            expect(time().getAttribute('aria-pressed')).toBe('true');
            time().click();
            await frame();
            expect(timeText()).toEqual(['1:01']);
          }
        }
        // Narrower bar, narrower transport.
        expect(widthOf.get(`${theme}@1000`)!).toBeLessThan(widthOf.get(`${theme}@1280`)! - 20);
        expect(widthOf.get(`${theme}@800`)!).toBeLessThanOrEqual(widthOf.get(`${theme}@1000`)! + 1);
      }
    } finally {
      if (was) root.dataset.theme = was;
      else delete root.dataset.theme;
      await page.viewport(1440, 900);
      await frame();
    }
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
      // Windows whose code loads on first use show "Loading…" until it arrives. Only what can be seen counts (innerText, not
      // textContent): a Decks panel always holds its stall note, a hidden "Loading…" that is not the window loading. The test used
      // to wait on that note for ever whenever the window had rendered within the one frame it was given, which a quiet machine does.
      await until(() => !(win.innerText ?? '').includes('Loading…'), 30_000, `the ${type} window to stop saying Loading…`);
      await frame();
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
    await until(() => !!document.querySelector('[role="dialog"]:not([data-window-id])'));
    await frame();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]:not([data-window-id])')!;
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
      'reference',
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
      await until(() => !(win.textContent ?? '').includes('Loading…'));
      const text = (win.innerText ?? '').replace(/\s+/g, ' ');
      // Canvas windows carry their instructions in the window's help and the hint bar (checked below).
      if (!NEXT_STEP.test(text)) vague.push(`${type}: "${text.slice(0, 80)}"`);
    }
    expect(vague).toEqual([]);
  });

  it('text is readable in every theme: dim and faint text, and the accent used as text', () => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    /** A token's color as 0-255 RGB, resolved through the browser (color-mix and var() included). */
    const rgb = (token: string): [number, number, number] => {
      probe.style.color = `var(${token})`;
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = getComputedStyle(probe).color;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    };
    const lum = (c: number[]) => {
      const f = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!;
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
      return (hi + 0.05) / (lo + 0.05);
    };
    // Minimum contrast against the page and the panel surfaces (WCAG: 4.5 for text; faint text is hints and disabled).
    const NEED: [string, number, string[]][] = [
      ['--ag-text', 7, ['--ag-bg', '--ag-surface-1', '--ag-glass', '--ag-glass-strong']],
      ['--ag-text-dim', 4.5, ['--ag-bg', '--ag-surface-1', '--ag-glass']],
      ['--ag-text-faint', 3, ['--ag-bg', '--ag-surface-1']],
      ['--ag-accent-ink', 4.5, ['--ag-bg', '--ag-surface-1', '--ag-surface-2']],
    ];
    const root = document.documentElement;
    const was = root.dataset.theme;
    const low: string[] = [];
    try {
      for (const theme of ['marble', 'carrara', 'classic', 'midnight', 'graphite', 'light']) {
        if (theme === 'marble') delete root.dataset.theme;
        else root.dataset.theme = theme;
        for (const [fg, min, bgs] of NEED)
          for (const bg of bgs) {
            const r = ratio(rgb(fg), rgb(bg));
            if (r < min) low.push(`${theme}: ${fg} on ${bg} is ${r.toFixed(1)}:1 (needs ${min})`);
          }
      }
    } finally {
      if (was) root.dataset.theme = was;
      else delete root.dataset.theme;
      probe.remove();
    }
    expect(low).toEqual([]);
  });

  it('text on accent fills (buttons, the active Studio button) is readable for every theme and accent', () => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgb = (token: string) => {
      probe.style.color = `var(${token})`;
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = getComputedStyle(probe).color;
      g.fillRect(0, 0, 1, 1);
      return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const lum = (c: number[]) => {
      const f = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!;
    };
    const root = document.documentElement;
    const [t0, a0] = [root.dataset.theme, root.dataset.accent];
    const low: string[] = [];
    try {
      for (const theme of ['marble', 'carrara', 'classic', 'midnight', 'graphite', 'light'])
        for (const accent of [
          undefined,
          'orange',
          'champagne',
          'rose',
          'blue',
          'green',
          'purple',
          'pink',
          'yellow',
          'red',
        ]) {
          if (theme === 'marble') delete root.dataset.theme;
          else root.dataset.theme = theme;
          if (accent) root.dataset.accent = accent;
          else delete root.dataset.accent;
          const [a, b] = [lum(rgb('--ag-on-accent')), lum(rgb('--ag-accent'))];
          const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          if (r < 4.5) low.push(`${theme}/${accent ?? 'default'}: ${r.toFixed(1)}:1`);
        }
    } finally {
      if (t0) root.dataset.theme = t0;
      else delete root.dataset.theme;
      if (a0) root.dataset.accent = a0;
      else delete root.dataset.accent;
      probe.remove();
    }
    expect(low).toEqual([]);
  });

  it('every built-in instrument and effect window: controls are named and have a hint', async () => {
    await s.files.newProject(createEmptyProject());
    const problems: string[] = [];
    let opened = 0;
    for (const entry of s.plugins.list()) {
      const def = entry.def;
      let props: Record<string, string> | null = null;
      if (def.kind === 'instrument') {
        const channelId = addInstrumentChannel(s, def.id);
        if (channelId) props = { kind: 'channel', channelId };
      } else {
        const insertId = addMixerInsert(s);
        const slotId = addEffect(s, insertId, def.id);
        if (slotId) props = { kind: 'fx', insertId, slotId };
      }
      if (!props) continue;
      const id = openWindow(s, 'plugin', props);
      await frame();
      const win = host.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
      if (!win) {
        problems.push(`${def.id}: window did not open`);
        continue;
      }
      await until(() => !(win.textContent ?? '').includes('Loading…'));
      await frame();
      opened++;
      const a = audit(win);
      problems.push(...a.unnamed.map((u) => `${def.name}: unnamed ${u}`));
      problems.push(...a.iconNoHint.map((u) => `${def.name}: icon-only without hint ${u}`));
      problems.push(...a.textOnly.map((u) => `${def.name}: no hint ${u}`));
      s.view.getState().hideWindow(id);
    }
    s.history.markSaved(); // later tests start new projects without a "keep your changes?" question
    expect(opened).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  }, 60_000);

  it('every step of the tour points at something that is on screen', async () => {
    const missing: string[] = [];
    for (const step of TOUR) {
      step.prepare?.(s);
      await frame();
      const el = document.querySelector(step.anchor);
      const r = el?.getBoundingClientRect();
      if (!el || !r || r.width === 0 || r.height === 0) missing.push(`${step.title}: ${step.anchor}`);
      else if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight)
        missing.push(`${step.title}: ${step.anchor} is off screen`);
    }
    expect(missing).toEqual([]);
    // The tour text names keys with {key:command}: each must be a real command.
    for (const step of TOUR)
      for (const m of step.body.matchAll(/\{key:([\w.]+)\}/g)) expect(s.commands.get(m[1]!), m[1]).toBeTruthy();
  });

  it('every lesson step points at something on screen once its step has started', async () => {
    const missing: string[] = [];
    for (const lesson of LESSONS) {
      if (lesson.start && !(await lesson.start(s))) continue;
      // The musician opens windows as the steps ask; here they are all open, with a Wavetable's window among them.
      for (const type of ['channel-rack', 'piano-roll', 'playlist', 'mixer']) openWindow(s, type);
      const wave = addInstrumentChannel(s, 'agstudio.wavetable');
      if (wave) openWindow(s, 'plugin', { kind: 'channel', channelId: wave });
      await frame();
      for (const step of lesson.steps) {
        step.prepare?.(s);
        await frame();
        const sel = step.anchor?.(s);
        if (sel === undefined) continue;
        const el = sel ? document.querySelector(sel) : null;
        if (!el) missing.push(`${lesson.id}: "${step.text.slice(0, 40)}" -> ${String(sel)}`);
      }
    }
    expect(missing).toEqual([]);
  }, 60_000);

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
