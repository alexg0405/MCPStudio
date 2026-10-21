/**
 * The rack window and its menus in the real React shell (headless Chrome, test services with the fake engine): the window opens from a
 * rack on a mixer track, macros are knobs with names that can be renamed and that show what they move, effects are added to and
 * dragged between branches, branches are muted, "Map to macro" is in the menu of every setting inside a rack, a slot of the mixer
 * says it is a rack, and every control has a name. Each edit is one undo step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { addRackChoice, allRacks } from '@app/actions/racks';
import { findRackChoice } from '@app/racks/library';
import { createTestServices } from '@app/testing';
import { targetKey } from '@core/model/targets';
import type { InsertId, SlotId } from '@core/model/types';
import { rackSlotOf } from '@core/query/rack';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { installKeyboard } from '@ui/keyboard';
import { paramMenuEntries } from '@ui/param-menu';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { EFFECT_DRAG, RACK_FX_DRAG } from '@ui/features/rack/rack-drag';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

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

describe('effect racks (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let insertId: InsertId;
  let rackId: SlotId;
  const project = () => s.doc.getState().project;
  const slot = () => rackSlotOf(project(), insertId, rackId)!;
  const rack = () => slot().rack;
  /** How many undo steps there are (the cursor's number keeps counting past undone ones). */
  const cursor = () => s.history.steps().done.length;
  const win = () => host.querySelector<HTMLElement>(`[data-window="rack:${rackId}"]`) ?? host.querySelector<HTMLElement>(`[data-window-id="rack:${rackId}"]`);
  const button = (name: string) => [...(win() ?? host).querySelectorAll<HTMLButtonElement>('button')].find((el) => el.getAttribute('aria-label') === name || el.textContent?.trim() === name);
  const slider = (label: string) => (win() ?? host).querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`);
  const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => el.textContent?.trim().startsWith(text));

  beforeAll(async () => {
    await page.viewport(1500, 950);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1500px;height:950px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    insertId = project().mixer.order[1] as InsertId;
    s.session.getState().selectInsert(insertId);
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'mixer');
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => host.textContent?.includes('Add effect') ?? false);
  });

  beforeEach(async () => {
    closeContextMenu();
    if (!rackId) {
      rackId = addRackChoice(s, insertId, findRackChoice(allRacks(s), 'Parallel NY')!)!;
      openWindow(s, 'rack', { insertId, slotId: rackId });
      await until(() => !!win() && !!slider('Macro 1: Blend'));
    }
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('shows the rack: its split, eight named macros, and a column for each branch with its effects', () => {
    expect(win()?.textContent).toContain('Rack ·');
    expect(slider('Macro 1: Blend')).not.toBeNull();
    expect(slider('Macro 5: Output')).not.toBeNull();
    expect(slider('Macro 8: Macro 8')).not.toBeNull();
    expect(win()?.querySelector('section[aria-label="Branch Dry"]')).not.toBeNull();
    const squashed = win()!.querySelector('section[aria-label="Branch Squashed"]')!;
    expect(squashed.textContent).toContain('Compressor');
    expect(squashed.textContent).toContain('EQ Pro');
    expect(win()!.querySelector<HTMLSelectElement>('select[aria-label="How the rack splits the sound"]')!.value).toBe('parallel');
    // The empty branch says it is the dry sound.
    expect(win()!.querySelector('section[aria-label="Branch Dry"]')!.textContent).toContain('the dry sound');
  });

  it('turns a macro from the keyboard: one undo step, saved as the rack plugin’s parameter', async () => {
    const before = cursor();
    const knob = slider('Macro 4: Sparkle')!;
    const start = Number(slot().plugin.params.macro4);
    knob.focus();
    await userEvent.keyboard('{ArrowUp}');
    await until(() => Number(slot().plugin.params.macro4) > start);
    expect(cursor()).toBe(before + 1);
    s.history.undo();
    expect(Number(slot().plugin.params.macro4)).toBeCloseTo(start, 9);
  });

  it('shows what a macro moves, with its range, and lets it go', async () => {
    await userEvent.click(button('Macro 2: Squash. Shows what it moves')!);
    await until(() => (win()?.textContent ?? '').includes('Macro 2 “Squash” moves'));
    const text = win()!.textContent ?? '';
    expect(text).toContain('Squashed · Compressor · Threshold');
    expect(text).toContain('Squashed · Compressor · Ratio');
    const before = cursor();
    await userEvent.click(button('Let go of Squashed · Compressor · Ratio')!);
    await until(() => rack().macros[1]!.mappings.length === 1);
    await frames(3);
    expect(cursor() - before, s.history.steps().done.map((e) => e.label).slice(-4).join(' | ')).toBe(1);
    s.history.undo();
    expect(rack().macros[1]!.mappings).toHaveLength(2);
  });

  it('renames a macro by double-click', async () => {
    const name = button('Macro 3: Snap. Shows what it moves')!;
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await until(() => !!win()!.querySelector('input[aria-label="Name of macro 3"]'));
    const input = win()!.querySelector<HTMLInputElement>('input[aria-label="Name of macro 3"]')!;
    await userEvent.fill(input, 'Bite');
    await userEvent.keyboard('{Enter}');
    await until(() => rack().macros[2]!.name === 'Bite');
    s.history.undo();
    expect(rack().macros[2]!.name).toBe('Snap');
  });

  it('adds an effect to a branch from its menu, and mutes a branch', async () => {
    const before = cursor();
    await userEvent.click(button('Add an effect to Dry')!);
    await until(() => !!menuItem('Saturator'));
    await userEvent.click(menuItem('Saturator')!);
    await until(() => rack().branches[0]!.fx.length >= 1);
    await frames(3);
    expect(rack().branches[0]!.fx.map((fx) => fx.plugin.pluginId)).toEqual(['agstudio.saturator']);
    expect(cursor() - before, s.history.steps().done.map((e) => e.label).slice(-4).join(' | ')).toBe(1);
    // A rack cannot hold a rack: the menu does not offer one.
    await userEvent.click(button('Add an effect to Dry')!);
    await until(() => !!menuItem('Saturator'));
    expect(menuItem('Rack')).toBeUndefined();
    closeContextMenu();
    await userEvent.click(button('Mute Squashed')!);
    await until(() => rack().branches[1]!.muted);
    expect(button('Mute Squashed')!.getAttribute('aria-pressed')).toBe('true');
    s.history.undo();
    s.history.undo();
    expect(rack().branches[0]!.fx).toHaveLength(0);
    expect(rack().branches[1]!.muted).toBe(false);
  });

  it('moves an effect to another branch by dragging its card, and adds one dragged in from the browser', async () => {
    const card = [...win()!.querySelectorAll<HTMLElement>('[draggable="true"]')].find((el) => el.textContent?.includes('Compressor'))!;
    const dry = win()!.querySelector<HTMLElement>('section[aria-label="Branch Dry"]')!;
    const data = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    expect(data.types).toContain(RACK_FX_DRAG);
    dry.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    dry.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    await until(() => rack().branches[0]!.fx.length === 1);
    expect(rack().branches[0]!.fx[0]!.plugin.pluginId).toBe('agstudio.compressor');
    expect(rack().macros[1]!.mappings).toHaveLength(2);
    s.history.undo();
    expect(rack().branches[0]!.fx).toHaveLength(0);
    const fromBrowser = new DataTransfer();
    fromBrowser.setData(EFFECT_DRAG, 'agstudio.chorus');
    dry.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: fromBrowser }));
    await until(() => rack().branches[0]!.fx.length === 1);
    expect(rack().branches[0]!.fx[0]!.plugin.pluginId).toBe('agstudio.chorus');
    s.history.undo();
  });

  it('Map to macro is in the menu of every setting inside a rack, and not on the macros themselves', () => {
    const effect = rack().branches[1]!.fx[1]!;
    const entries = paramMenuEntries({ target: { kind: 'plugin', owner: { kind: 'fx', insertId, slotId: effect.id }, paramId: 'makeup' }, spec: s.plugins.get('agstudio.compressor')!.params.makeup!, label: 'Compressor · Makeup' }, s);
    expect(entries.some((entry) => entry.kind === 'submenu' && entry.label.startsWith('Map to macro'))).toBe(true);
    const own = paramMenuEntries({ target: { kind: 'plugin', owner: { kind: 'fx', insertId, slotId: rackId }, paramId: 'macro1' }, spec: s.plugins.get('agstudio.rack')!.params.macro1!, label: 'Rack · Macro 1' }, s);
    expect(own.some((entry) => entry.kind === 'submenu' && entry.label.startsWith('Map to macro'))).toBe(false);
    const mix = paramMenuEntries({ target: { kind: 'slot', insertId, slotId: effect.id, param: 'mix' }, spec: s.plugins.get('agstudio.compressor')!.params.makeup!, label: 'Mix' }, s);
    expect(mix.some((entry) => entry.kind === 'submenu' && entry.label.startsWith('Map to macro'))).toBe(true);
    expect(targetKey({ kind: 'slot', insertId, slotId: effect.id, param: 'mix' })).toContain(effect.id);
  });

  it('a rack’s mixer slot says it is a rack and opens the rack window; the setting a macro moves says so', async () => {
    s.view.getState().hideWindow(`rack:${rackId}`);
    await frames(2);
    const slotName = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find((el) => el.getAttribute('aria-label')?.startsWith('Open the editor of Rack'))!;
    expect(slotName.textContent).toContain('2 branches');
    slotName.closest('[data-hint]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await until(() => !!win() && !!slider('Macro 1: Blend'));
    const effect = rack().branches[1]!.fx[1]!;
    const status = s.automation.statusOf(targetKey({ kind: 'plugin', owner: { kind: 'fx', insertId, slotId: effect.id }, paramId: 'threshold' }));
    expect(status).toMatchObject({ kind: 'macro' });
    expect(status?.hint).toContain('“Squash”');
    expect(s.automation.statusOf(targetKey({ kind: 'plugin', owner: { kind: 'fx', insertId, slotId: effect.id }, paramId: 'release' }))).toBeNull();
  });

  it('every control of the rack window has a name a screen reader can say', () => {
    const unnamed = [...win()!.querySelectorAll<HTMLElement>('button, input, select, [role="slider"]')].filter((el) => {
      const name = el.getAttribute('aria-label')?.trim() || el.textContent?.trim() || el.getAttribute('title');
      return !name;
    });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('a window opened with nothing says what a rack window needs', async () => {
    openWindow(s, 'rack', null);
    await until(() => (host.textContent ?? '').includes('not on a track any more'));
    s.view.getState().hideWindow('rack:');
  });
});
