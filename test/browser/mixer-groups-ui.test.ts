/**
 * The mixer's groups, VCA strips and snapshots in the real React shell (headless Chrome, test services with the fake
 * engine): picking tracks, grouping, a linked fader and mute, the group menu and VCA strip, solo-safe, and the Mix
 * snapshots window with its empty state and A/B switch. Each edit is one undo step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { MASTER, type InsertId } from '@core/model/types';
import { setInsertProp } from '@core/ops/mixer';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY } from '../helpers/wait';

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

describe('mixer groups, VCA and snapshots (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let a: InsertId;
  let b: InsertId;
  let c: InsertId;
  const project = () => s.doc.getState().project;
  const volume = (id: InsertId) => project().mixer.inserts[id]!.volume;
  const nameOf = (id: InsertId) => project().mixer.inserts[id]!.name;
  /** The strip's own area (its name), where a plain or Shift-click picks it. */
  const stripName = (id: InsertId) => [...host.querySelectorAll<HTMLElement>('[title]')].find((el) => el.title === nameOf(id))!;
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === name)!;
  const slider = (label: string) => host.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`)!;
  const menuItem = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim().startsWith(text));
  const wheel = (el: Element, deltaY: number) =>
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
  const cursor = () => s.history.status().cursor;

  beforeAll(async () => {
    await page.viewport(1400, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1400px;height:900px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    [a, b, c] = project().mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
    s.history.transact('names', (d) => {
      setInsertProp(d, a, 'name', 'Kick');
      setInsertProp(d, b, 'name', 'Snare');
      setInsertProp(d, c, 'name', 'Hat');
    });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'mixer');
    s.view.getState().setMaximized('mixer', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!stripName(a));
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    s.history.transact('reset', (d) => {
      delete d.mixer.groups;
      delete d.mixSnapshots;
      for (const id of [a, b, c]) {
        setInsertProp(d, id, 'volume', 1);
        setInsertProp(d, id, 'muted', false);
        delete d.mixer.inserts[id]!.soloSafe;
      }
    });
    s.session.getState().markInserts([]);
    s.session.getState().setSnapshotCompare({ a: null, b: null, side: null });
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('Group and Link selected wait for two picked tracks and say how to pick them', async () => {
    expect(button('Group').disabled).toBe(true);
    expect(button('Link selected').disabled).toBe(true);
    expect(host.textContent).toContain('Shift-click strips to pick tracks');
    await userEvent.click(stripName(a));
    // A Shift-press on the strip's own area picks it too.
    stripName(b).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, shiftKey: true }));
    await until(() => !button('Group').disabled);
    expect(host.textContent).toContain('2 tracks picked');
  });

  it('grouping makes a coloured band on both strips; a linked fader moves the group and undoes in one step', async () => {
    s.session.getState().selectInsert(a);
    s.session.getState().toggleMarkedInsert(b);
    await until(() => !button('Group').disabled);
    const before = cursor();
    await userEvent.click(button('Group'));
    expect(project().mixer.groups![0]!.members).toEqual([a, b]);
    await until(() => host.querySelectorAll('button[aria-label="Group Group 1"]').length === 2);

    wheel(slider('Kick volume'), -1);
    await frames(2);
    await expect.poll(() => volume(a), EVENTUALLY).toBeGreaterThan(1);
    expect(volume(b)).toBeCloseTo(volume(a), 9);
    expect(volume(c)).toBe(1);
    await s.history.undo();
    expect(volume(a)).toBe(1);
    expect(volume(b)).toBe(1);
    await s.history.undo();
    expect(project().mixer.groups).toBeUndefined();
    expect(cursor()).toBe(before);
  });

  it('muting one grouped track mutes the group', async () => {
    s.session.getState().selectInsert(a);
    s.session.getState().toggleMarkedInsert(b);
    await userEvent.click(button('Group'));
    await until(() => !!host.querySelector('button[aria-label="Mute Insert 1"]'));
    await userEvent.click(host.querySelector('button[aria-label="Mute Insert 1"]')!);
    expect(project().mixer.inserts[a]!.muted && project().mixer.inserts[b]!.muted).toBe(true);
    expect(project().mixer.inserts[c]!.muted).toBe(false);
  });

  it('the group menu adds a VCA strip whose fader scales the group without moving the faders', async () => {
    s.session.getState().selectInsert(a);
    s.session.getState().toggleMarkedInsert(b);
    await userEvent.click(button('Group'));
    await until(() => host.querySelectorAll('button[aria-label="Group Group 1"]').length === 2);
    const band = host.querySelector('button[aria-label="Group Group 1"]')!;
    band.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 }));
    await until(() => !!menuItem('Add a VCA fader'));
    menuItem('Add a VCA fader')!.click();
    await until(() => !!slider('Group 1 VCA'));
    expect(project().mixer.groups![0]!.vca).toBe(1);

    wheel(slider('Group 1 VCA'), 1);
    await frames(2);
    expect(project().mixer.groups![0]!.vca!).toBeLessThan(1);
    expect(volume(a)).toBe(1);
    expect(volume(b)).toBe(1);
    expect(host.textContent).toMatch(/VCA/);
    await s.history.undo();
    expect(project().mixer.groups![0]!.vca).toBe(1);
  });

  it('solo-safe is in a strip’s menu and shows a badge', async () => {
    const insertStrip = stripName(c).closest('[class*="strip"]')!;
    insertStrip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
    await until(() => !!menuItem('Solo-safe'));
    menuItem('Solo-safe')!.click();
    expect(project().mixer.inserts[c]!.soloSafe).toBe(true);
    await until(() => host.textContent!.includes('SAFE'));
  });

  it('the Mix snapshots window explains itself when empty, saves, and switches A and B', async () => {
    s.commands.run('view.mixSnapshots');
    await until(() => !!host.querySelector('[data-window-type="mix-snapshots"]'));
    const win = () => host.querySelector<HTMLElement>('[data-window-type="mix-snapshots"]')!;
    // The window's code loads on first use.
    await until(() => !!win().textContent?.includes('No snapshots yet'));
    const save = [...win().querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === 'Save snapshot')!;
    await userEvent.click(save);
    s.history.transact('quiet', (d) => setInsertProp(d, a, 'volume', 0.5));
    await userEvent.click(save);
    await until(() => win().querySelectorAll('li').length === 2);
    expect(win().textContent).not.toContain('No snapshots yet');

    const rows = [...win().querySelectorAll('li')];
    const slotButtons = (row: Element) => [...row.querySelectorAll<HTMLButtonElement>('button')].filter((el) => el.textContent === 'A' || el.textContent === 'B');
    await userEvent.click(slotButtons(rows[0]!)[0]!);
    await userEvent.click(slotButtons(rows[1]!)[1]!);
    const ab = [...win().querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.startsWith('A/B'))!;
    await until(() => !ab.disabled);
    await userEvent.click(ab);
    expect(volume(a)).toBe(1);
    await userEvent.click(ab);
    expect(volume(a)).toBe(0.5);
    // Diff names the change in words.
    const diff = [...rows[0]!.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === 'Diff')!;
    await userEvent.click(diff);
    await until(() => win().textContent!.includes('Kick: fader'));
    expect(project().mixer.inserts[MASTER]).toBeDefined();
  });
});
