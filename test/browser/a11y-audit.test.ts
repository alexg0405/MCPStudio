/**
 * Accessibility audit of the running shell (headless Chrome, real React tree): the toolbar, the menus, every window
 * type and the main dialogs are checked for what a keyboard or screen-reader user needs.
 *
 * - Every interactive element and every named role has an accessible name.
 * - Every `role` is a real ARIA role, its `aria-*` attributes are allowed on it and have valid values, required
 *   attributes (`aria-valuenow` on a slider, `aria-checked` on a switch) are there, required parents and children exist,
 *   `aria-labelledby` and friends point at real ids, and no id is used twice.
 * - Tab never gets trapped (a real Tab key, window by window), no tab stop is positive, every roving group has exactly
 *   one tab stop, and every visible control can be reached by Tab or by the arrows of a group.
 * - Whatever a keyboard puts the focus on shows a ring.
 * - Roving groups (the toolbar, the step grid, the clip launcher) move with the arrow keys.
 * - Dialogs and menus take the focus in, keep Tab inside, close on Esc and give the focus back to their opener.
 *
 * The checks themselves live in `test/helpers/aria-audit.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { page, userEvent } from 'vitest/browser';
import { createServices, type Services } from '@app/services';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { installRoving } from '@ui/a11y/roving';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import { openWindow, windowTypes } from '@ui/workspace/registry';
import { getMenus } from '@ui/shell/menus';
import { showDialog } from '@ui/controls/Dialog';
import { showFormDialog } from '@ui/controls/FormDialog';
import { showContextMenu } from '@ui/controls/ContextMenu';
import { addInstrumentChannel } from '@app/actions/channels';
import { addEffect, addMixerInsert } from '@app/actions/mixer';
import { createEmptyProject } from '@core/model/defaults';
import {
  ariaProblems,
  describe as describeElement,
  hasFocusRing,
  interactiveIn,
  isTabStop,
  isVisible,
  nameProblems,
  rovingProblems,
  structureProblems,
  unreachableProblems,
} from '../helpers/aria-audit';
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

/** More Tab stops than this inside one window means a grid or list that should be one stop is not. */
const MAX_TAB_STOPS_PER_WINDOW = 90;

/** The totals printed at the end, for whoever reads the test log. */
const totals = { elements: 0, windows: 0, groups: 0, tabStops: 0, ringsChecked: 0, menus: 0, dialogs: 0 };

/** Every static check on one region; returns the problems with the region's name in front. */
function auditRegion(label: string, region: Element): string[] {
  const interactive = interactiveIn(region);
  totals.elements += interactive.length;
  const roving = rovingProblems(region);
  totals.groups += roving.groups;
  return [
    ...nameProblems(region),
    ...ariaProblems(region),
    ...structureProblems(region),
    ...unreachableProblems(region),
    ...roving.problems,
  ].map((p) => `${label}: ${p}`);
}

/** The first element in `region` that Tab can land on. */
function firstTabStop(region: Element): HTMLElement | undefined {
  return interactiveIn(region).find(isTabStop);
}

/**
 * Presses the real Tab key from the region's first stop until focus leaves the region, checking every stop for a
 * visible ring. Returns what went wrong and how many stops there were.
 */
async function tabThrough(label: string, region: HTMLElement): Promise<{ problems: string[]; stops: number }> {
  const problems: string[] = [];
  const first = firstTabStop(region);
  if (!first) return { problems, stops: 0 };
  first.focus();
  const seen = new Set<Element>([first]);
  let stops = 1;
  for (let press = 0; press < MAX_TAB_STOPS_PER_WINDOW + 10; press++) {
    await userEvent.tab();
    const now = document.activeElement;
    if (!now || !region.contains(now)) return { problems, stops };
    if (seen.has(now)) {
      problems.push(`${label}: Tab went round in a circle at ${describeElement(now)}`);
      return { problems, stops };
    }
    seen.add(now);
    stops++;
    totals.ringsChecked++;
    if (!hasFocusRing(now)) problems.push(`${label}: no visible focus ring on ${describeElement(now)}`);
  }
  problems.push(`${label}: more than ${MAX_TAB_STOPS_PER_WINDOW} Tab stops, or Tab never leaves`);
  return { problems, stops };
}

describe('Accessibility audit (shell)', () => {
  let s: Services;
  let root: Root;
  let host: HTMLDivElement;
  let stopRoving: () => void;

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
    stopRoving = installRoving();
    applyDefaultLayout(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    await frame();
  });

  afterAll(async () => {
    console.info('A11y audit totals:', JSON.stringify(totals));
    stopRoving();
    root.unmount();
    host.remove();
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  /** Opens a window type and waits until it has stopped saying Loading…; null when the type needs props. */
  async function open(type: string, props: Record<string, string> | null = null): Promise<HTMLElement | null> {
    let id: string;
    try {
      id = openWindow(s, type, props);
    } catch {
      return null;
    }
    await frame();
    const win = host.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
    if (!win) return null;
    await until(() => !(win.innerText ?? '').includes('Loading…'), 30_000, `the ${type} window to stop loading`);
    await frame();
    return win;
  }

  it('the toolbar: named, valid ARIA, reachable, one tab stop per group', async () => {
    const header = host.querySelector<HTMLElement>('header')!;
    await s.engine.resume();
    await frame();
    expect(auditRegion('toolbar', header)).toEqual([]);
    const toolbars = [...header.querySelectorAll('[role="toolbar"], [role="menubar"]')];
    expect(toolbars.length).toBeGreaterThanOrEqual(3);
    const { problems, stops } = await tabThrough('toolbar', header);
    totals.tabStops += stops;
    console.info(`A11y audit: the toolbar has ${stops} Tab stops`);
    expect(stops).toBeLessThanOrEqual(24);
    expect(problems).toEqual([]);
  });

  it('the toolbar is a roving group: the arrow keys move inside it', async () => {
    const header = host.querySelector<HTMLElement>('header')!;
    const bar = header.querySelector<HTMLElement>('[role="toolbar"][data-tour="transport"], [data-tour="transport"] [role="toolbar"]');
    expect(bar, 'a transport toolbar').toBeTruthy();
    const items = [...bar!.querySelectorAll<HTMLElement>('button')].filter((b) => isVisible(b) && !(b as HTMLButtonElement).disabled);
    expect(items.length).toBeGreaterThan(2);
    const stop = items.find((b) => b.getAttribute('tabindex') === '0')!;
    expect(stop).toBeTruthy();
    stop.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).not.toBe(stop);
    expect(bar!.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(stop);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items[items.length - 1]);
    (document.activeElement as HTMLElement).blur();
  });

  it('the menu bar is a menubar whose labels are one tab stop', async () => {
    const bar = host.querySelector<HTMLElement>('[role="menubar"]');
    expect(bar).toBeTruthy();
    const labels = [...bar!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(labels.length).toBeGreaterThan(4);
    expect(labels.filter((l) => l.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(bar!.getAttribute('aria-label')).toBeTruthy();
  });

  it('every menu opens from the keyboard; its entries are named, valid and arrow-navigable; Esc closes it and returns the focus', async () => {
    const problems: string[] = [];
    for (const m of getMenus()) {
      const label = host.querySelector<HTMLElement>(`[data-menu="${m.id}"]`);
      if (!label) continue;
      label.focus();
      await userEvent.keyboard('{ArrowDown}');
      await frame();
      const panel = host.querySelector<HTMLElement>('[role="menu"]');
      if (!panel) {
        problems.push(`${m.label}: did not open from the keyboard`);
        continue;
      }
      totals.menus++;
      problems.push(...auditRegion(`menu ${m.label}`, panel));
      const items = [...panel.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((i) => i.closest('[role="menu"]') === panel && !(i as HTMLButtonElement).disabled);
      if (!items.includes(document.activeElement as HTMLElement)) problems.push(`menu ${m.label}: the first entry did not take the focus`);
      if (items.length > 1) {
        await userEvent.keyboard('{ArrowDown}');
        if (document.activeElement !== items[1] && document.activeElement !== items[0]) {
          problems.push(`menu ${m.label}: ArrowDown did not move to the next entry`);
        }
      }
      await userEvent.keyboard('{Escape}');
      await frame();
      if (host.querySelector('[role="menu"]')) problems.push(`menu ${m.label}: Esc did not close it`);
      if (document.activeElement !== label) problems.push(`menu ${m.label}: the focus did not return to its label`);
    }
    expect(problems).toEqual([]);
  });

  it('every window opens; names, ARIA, structure, tab order and focus rings are right', async () => {
    const problems: string[] = [];
    const opened: string[] = [];
    const stopsPerWindow: string[] = [];
    for (const type of windowTypes()) {
      const win = await open(type);
      if (!win) continue;
      opened.push(type);
      totals.windows++;
      problems.push(...auditRegion(type, win));
      const tab = await tabThrough(type, win);
      totals.tabStops += tab.stops;
      stopsPerWindow.push(`${type}:${tab.stops}`);
      problems.push(...tab.problems);
    }
    console.info('A11y audit windows:', stopsPerWindow.join(' '));
    expect(opened.length).toBeGreaterThan(8);
    expect(problems).toEqual([]);
  }, 300_000);

  it('the browser sidebar', async () => {
    const side = host.querySelector<HTMLElement>('aside') ?? host.querySelector<HTMLElement>('[data-tour="browser"]');
    expect(side).toBeTruthy();
    const problems = auditRegion('browser', side!);
    const tab = await tabThrough('browser', side!);
    totals.tabStops += tab.stops;
    console.info(`A11y audit: the browser sidebar has ${tab.stops} Tab stops`);
    expect([...problems, ...tab.problems]).toEqual([]);
  });

  it('the channel rack step grid is a grid of steps that the arrows move through', async () => {
    await s.files.newProject(createEmptyProject());
    addInstrumentChannel(s, 'agstudio.drum-synth');
    addInstrumentChannel(s, 'agstudio.drum-synth');
    const win = await open('channel-rack');
    expect(win).toBeTruthy();
    await frame();
    const grid = win!.querySelector<HTMLElement>('[data-roving="grid"]');
    expect(grid, 'the step grid is a roving grid').toBeTruthy();
    const steps = [...grid!.querySelectorAll<HTMLElement>('button')].filter(isVisible);
    expect(steps.length).toBeGreaterThan(30);
    const stop = steps.find((b) => b.getAttribute('tabindex') === '0')!;
    stop.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(steps[steps.indexOf(stop) + 1]);
    await userEvent.keyboard('{ArrowDown}');
    const below = document.activeElement as HTMLElement;
    expect(grid!.contains(below)).toBe(true);
    expect(below.getBoundingClientRect().top).toBeGreaterThan(stop.getBoundingClientRect().top);
    expect(steps[0]!.getAttribute('aria-label') ?? '').toMatch(/step 1\b/i);
    expect(steps[0]!.getAttribute('aria-pressed')).toBe('false');
    // Space on a keyboard-focused step toggles it, and the label follows.
    const before = s.doc.getState().project;
    await userEvent.keyboard(' ');
    await frame();
    expect(s.doc.getState().project).not.toBe(before);
    expect(document.activeElement!.getAttribute('aria-pressed')).toBe('true');
    s.history.undo();
    (document.activeElement as HTMLElement).blur();
  });

  it('the clip launcher grid is a roving grid with named pads', async () => {
    const win = await open('launcher');
    expect(win).toBeTruthy();
    const grid = win!.querySelector<HTMLElement>('[data-roving="grid"]');
    expect(grid, 'the launcher is a roving grid').toBeTruthy();
    const pads = [...grid!.querySelectorAll<HTMLElement>('button')].filter((b) => isVisible(b) && !b.hasAttribute('disabled'));
    expect(pads.length).toBeGreaterThan(4);
    for (const pad of pads) expect(pad.getAttribute('aria-label') ?? pad.textContent, 'a pad has a name').toBeTruthy();
    const stop = pads.find((b) => b.getAttribute('tabindex') === '0')!;
    stop.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).not.toBe(stop);
    expect(grid!.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
  });

  it('every built-in instrument and effect window is named, valid and has no keyboard trap', async () => {
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
      const win = await open('plugin', props);
      if (!win) {
        problems.push(`${def.id}: window did not open`);
        continue;
      }
      opened++;
      problems.push(...auditRegion(def.name, win));
      const tab = await tabThrough(def.name, win);
      totals.tabStops += tab.stops;
      problems.push(...tab.problems);
      s.view.getState().hideWindow(win.dataset.windowId!);
    }
    s.history.markSaved();
    totals.windows += opened;
    console.info(`A11y audit: ${opened} plugin windows`);
    expect(opened).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  }, 300_000);

  describe('dialogs', () => {
    /** Runs `show` with the focus on a toolbar button, checks the dialog, closes it with Esc and checks the focus came back. */
    async function checkDialog(label: string, show: () => Promise<unknown> | void, kind: 'dialog' | 'alertdialog'): Promise<string[]> {
      const problems: string[] = [];
      const opener = host.querySelector<HTMLElement>('header button:not([disabled])')!;
      opener.focus();
      const closed = show();
      await until(() => !!document.querySelector(`[role="${kind}"]`), 10_000, `the ${label} dialog`);
      await frame();
      const dialog = document.querySelector<HTMLElement>(`[role="${kind}"]`)!;
      totals.dialogs++;
      if (dialog.getAttribute('aria-modal') !== 'true') problems.push(`${label}: aria-modal is not true`);
      if (!dialog.getAttribute('aria-labelledby') && !dialog.getAttribute('aria-label')) problems.push(`${label}: no label`);
      if (!dialog.contains(document.activeElement)) problems.push(`${label}: the focus did not move into the dialog`);
      problems.push(...auditRegion(label, dialog));
      // Tab and Shift+Tab many times: the focus never leaves.
      for (let i = 0; i < 14; i++) {
        await userEvent.tab();
        if (!dialog.contains(document.activeElement)) {
          problems.push(`${label}: Tab left the dialog after ${i + 1} presses`);
          break;
        }
      }
      await userEvent.tab({ shift: true });
      if (!dialog.contains(document.activeElement)) problems.push(`${label}: Shift+Tab left the dialog`);
      await userEvent.keyboard('{Escape}');
      await frame();
      await closed;
      if (document.querySelector(`[role="${kind}"]`)) problems.push(`${label}: Esc did not close it`);
      if (document.activeElement !== opener) problems.push(`${label}: the focus did not return to the control that opened it`);
      return problems;
    }

    it('a question dialog, a form dialog and the welcome dialog', async () => {
      const problems = [
        ...(await checkDialog(
          'question',
          () => showDialog({ title: 'Keep your changes?', message: 'The song has changes.', buttons: [{ id: 'save', label: 'Save', primary: true }, { id: 'no', label: "Don't save", danger: true }, { id: 'cancel', label: 'Cancel' }], cancelId: 'cancel' }),
          'alertdialog',
        )),
        ...(await checkDialog(
          'form',
          () =>
            showFormDialog({
              title: 'Tool settings',
              message: 'Pick values.',
              fields: [
                { kind: 'text', key: 'name', label: 'Name' },
                { kind: 'number', key: 'bars', label: 'Bars', min: 1, max: 64 },
                { kind: 'choice', key: 'kind', label: 'Kind', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
              ],
              values: { name: 'x', bars: 4, kind: 'a' },
            }),
          'dialog',
        )),
        ...(await checkDialog('welcome', () => {
          s.commands.run('help.welcome');
        }, 'dialog')),
      ];
      expect(problems).toEqual([]);
    });

    it('the export dialog', async () => {
      const problems = await checkDialog('export', () => {
        s.commands.run('file.exportWav');
      }, 'dialog');
      expect(problems).toEqual([]);
    });
  });

  it('a context menu takes the focus, names its entries, closes on Esc and returns the focus', async () => {
    const opener = host.querySelector<HTMLElement>('header button:not([disabled])')!;
    opener.focus();
    showContextMenu({ x: 300, y: 300 }, [
      { kind: 'label', label: 'Channel' },
      { label: 'Rename', onSelect: () => {} },
      { label: 'Mute', checked: true, onSelect: () => {} },
      { kind: 'separator' },
      { kind: 'submenu', label: 'Color', items: [{ label: 'Red', onSelect: () => {} }] },
    ]);
    await until(() => !!document.querySelector('[role="menu"]'));
    await frame();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const problems = auditRegion('context menu', menu);
    if (!menu.contains(document.activeElement)) problems.push('context menu: the focus did not move into the menu');
    expect(menu.querySelector('[role="menuitemcheckbox"][aria-checked="true"]'), 'a checked entry is a menuitemcheckbox').toBeTruthy();
    await userEvent.keyboard('{ArrowDown}');
    expect(menu.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    await frame();
    if (document.querySelector('[role="menu"]')) problems.push('context menu: Esc did not close it');
    if (document.activeElement !== opener) problems.push('context menu: the focus did not return to the opener');
    expect(problems).toEqual([]);
  });

  it('the action search is a combobox with a listbox of options', async () => {
    s.commands.run('help.palette');
    await until(() => !!document.querySelector('[role="combobox"]'));
    await frame();
    const combo = document.querySelector<HTMLElement>('[role="combobox"]')!;
    const dialog = combo.closest<HTMLElement>('[role="dialog"]') ?? combo.parentElement!;
    const problems = auditRegion('action search', dialog);
    const listId = combo.getAttribute('aria-controls');
    const list = listId ? document.getElementById(listId) : null;
    if (!list || list.getAttribute('role') !== 'listbox') problems.push('action search: aria-controls does not point at a listbox');
    if (combo.getAttribute('aria-expanded') !== 'true') problems.push('action search: aria-expanded should be true while results show');
    const active = combo.getAttribute('aria-activedescendant');
    if (!active || document.getElementById(active)?.getAttribute('role') !== 'option') problems.push('action search: aria-activedescendant is not an option');
    await userEvent.keyboard('{ArrowDown}');
    const moved = combo.getAttribute('aria-activedescendant');
    if (!moved || moved === active) problems.push('action search: ArrowDown did not move the active option');
    await userEvent.keyboard('{Escape}');
    await frame();
    expect(problems).toEqual([]);
  });
});
