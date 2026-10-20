/**
 * Channel rack interactions (headless Chrome, the real React shell, test services with the fake engine):
 * clicking and dragging steps, the mixer-insert number typed in, mute and solo, and the row menu's
 * reorder, each as one undo step, with Esc and out-of-range numbers handled.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addMixerInsert } from '@app/actions/mixer';
import { MASTER, type ChannelId, type InsertId, type PatternId } from '@core/model/types';
import { notesSorted } from '@core/query/queries';
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

describe('channel rack interactions (UI)', { timeout: 40_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let pattern: PatternId;
  let channels: ChannelId[];
  const rack = () => host.querySelector<HTMLElement>('[data-window-type="channel-rack"]')!;
  const row = (id: ChannelId) => rack()?.querySelector<HTMLElement>(`[data-channel-id="${id}"]`) as HTMLElement;
  const step = (id: ChannelId, i: number) => row(id).querySelectorAll<HTMLButtonElement>('button[aria-label^="Step "]')[i]!;
  const project = () => s.doc.getState().project;
  const stepsOn = (id: ChannelId) => notesSorted(project().patterns[pattern]?.notes[id]).map((n) => n.tick / 240);
  const cursor = () => s.history.status().cursor;
  const label = () => s.history.status().undoLabel;
  const pointer = (el: Element, type: string, init: PointerEventInit = {}) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, ...init }));
  /** The pointer moving onto a step (React derives pointerenter from pointerover). */
  const over = (el: Element, init: PointerEventInit = {}) =>
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, ...init }));
  const insertBox = (id: ChannelId) => row(id).querySelector<HTMLElement>('[data-hint^="Mixer insert"]')!;
  const insertInput = (id: ChannelId) => row(id).querySelector<HTMLInputElement>('input[aria-label="Mixer insert"]');
  const output = (id: ChannelId) => {
    const ch = project().channels[id];
    return ch && ch.kind !== 'automation' ? ch.output : MASTER;
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    pattern = project().patternOrder[0] as PatternId;
    s.view.getState().setCurrentPattern(pattern);
    addMixerInsert(s, 0);
    addMixerInsert(s, 1);
    channels = project().channelOrder.filter((id) => project().channels[id]?.kind === 'instrument') as ChannelId[];
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'channel-rack');
    s.view.getState().setMaximized('channel-rack', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!row(channels[0]!));
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    // Clear every step and put the first channel back on the master.
    const { removeNotes } = await import('@core/ops/notes');
    s.history.transact('reset', (d) => {
      for (const id of channels) {
        const ids = notesSorted(d.patterns[pattern]?.notes[id]).map((n) => n.id);
        if (ids.length) removeNotes(d, pattern, id, ids);
        const ch = d.channels[id];
        if (ch && ch.kind !== 'automation') {
          ch.output = MASTER;
          ch.muted = false;
          ch.solo = false;
        }
      }
    });
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('clicking a step turns it on, clicking it again turns it off, each one undo step', async () => {
    const id = channels[0]!;
    const before = cursor();
    await userEvent.click(step(id, 4));
    expect(stepsOn(id)).toEqual([4]);
    expect(label()).toBe('Paint steps');
    await userEvent.click(step(id, 4));
    expect(stepsOn(id)).toEqual([]);
    expect(label()).toBe('Erase steps');
    await s.history.undo();
    await s.history.undo();
    expect(cursor()).toBe(before);
  });

  it('dragging across steps paints them in one undo step, even when the pointer goes fast', async () => {
    const id = channels[0]!;
    const before = cursor();
    pointer(step(id, 1), 'pointerdown');
    over(step(id, 2));
    over(step(id, 6)); // skipped 3-5: filled in
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse' }));
    expect(stepsOn(id)).toEqual([1, 2, 3, 4, 5, 6]);
    await s.history.undo();
    expect(stepsOn(id)).toEqual([]);
    expect(cursor()).toBe(before);
  });

  it('a cancelled pointer ends the paint (it is not left painting)', async () => {
    const id = channels[0]!;
    pointer(step(id, 1), 'pointerdown');
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }));
    over(step(id, 3), { buttons: 0 });
    expect(stepsOn(id)).toEqual([1]);
  });

  it('a paint whose button was let go outside the window ends when the pointer comes back', async () => {
    const id = channels[0]!;
    pointer(step(id, 1), 'pointerdown');
    over(step(id, 2));
    over(step(id, 4), { buttons: 0 });
    over(step(id, 6), { buttons: 0 });
    expect(stepsOn(id)).toEqual([1, 2]);
    await s.history.undo();
    expect(stepsOn(id)).toEqual([]);
  });

  it('a right-click erases a step and a right-drag erases a run (one step)', async () => {
    const id = channels[0]!;
    await userEvent.click(step(id, 0));
    await userEvent.click(step(id, 1));
    await userEvent.click(step(id, 2));
    pointer(step(id, 0), 'pointerdown', { button: 2, buttons: 2 });
    over(step(id, 2), { button: 2, buttons: 2 });
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse' }));
    expect(stepsOn(id)).toEqual([]);
    await s.history.undo();
    expect(stepsOn(id)).toEqual([0, 1, 2]);
  });

  it('the mixer insert number: click, type it, Enter routes the channel (one undo step)', async () => {
    const id = channels[0]!;
    const before = cursor();
    await userEvent.click(insertBox(id));
    await until(() => !!insertInput(id) && document.activeElement === insertInput(id));
    await userEvent.keyboard('2{Enter}');
    await until(() => !insertInput(id));
    expect(output(id)).toBe(project().mixer.order[2]);
    expect(label()).toBe('Route channel');
    await s.history.undo();
    expect(output(id)).toBe(MASTER);
    expect(cursor()).toBe(before);
  });

  it('typing “--” or “master” routes to the master; Esc cancels; a number past the last insert clamps', async () => {
    const id = channels[0]!;
    await userEvent.click(insertBox(id));
    await until(() => !!insertInput(id) && document.activeElement === insertInput(id));
    await userEvent.keyboard('1{Enter}');
    await until(() => !insertInput(id));
    expect(output(id)).toBe(project().mixer.order[1]);
    await userEvent.click(insertBox(id));
    await until(() => !!insertInput(id) && document.activeElement === insertInput(id));
    await userEvent.keyboard('master{Enter}');
    await until(() => !insertInput(id));
    expect(output(id)).toBe(MASTER);
    const before = cursor();
    await userEvent.click(insertBox(id));
    await until(() => !!insertInput(id) && document.activeElement === insertInput(id));
    await userEvent.keyboard('2{Escape}');
    await until(() => !insertInput(id));
    expect(output(id)).toBe(MASTER);
    expect(cursor()).toBe(before);
    await userEvent.click(insertBox(id));
    await until(() => !!insertInput(id) && document.activeElement === insertInput(id));
    await userEvent.keyboard('99{Enter}');
    await until(() => !insertInput(id));
    expect(output(id)).toBe(project().mixer.order[project().mixer.order.length - 1] as InsertId);
  });

  it('the LED mutes (one step) and a right-click on it solos', async () => {
    const id = channels[0]!;
    const led = row(id).querySelector<HTMLButtonElement>('button[aria-label="Mute"]')!;
    const before = cursor();
    await userEvent.click(led);
    expect(project().channels[id]).toMatchObject({ muted: true });
    expect(label()).toBe('Mute');
    await s.history.undo();
    expect(cursor()).toBe(before);
    led.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(project().channels[id]).toMatchObject({ solo: true });
    await s.history.undo();
    expect(project().channels[id]).toMatchObject({ solo: false });
  });

  it('the row menu’s Move down / Move up reorders the rack (one step each)', async () => {
    if (channels.length < 2) return;
    const [a, b] = channels as [ChannelId, ChannelId];
    const order = () => project().channelOrder.filter((id) => id === a || id === b);
    expect(order()).toEqual([a, b]);
    const name = row(a).querySelector<HTMLElement>('button[data-hint*="right-click for options"]')!;
    name.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    await until(() => !!document.querySelector('[role="menu"]'));
    const move = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((i) => i.textContent?.includes('Move down'))!;
    move.click();
    await frames(2);
    await expect.poll(() => order(), EVENTUALLY).toEqual([b, a]);
    await s.history.undo();
    expect(order()).toEqual([a, b]);
  });
  it('switching patterns shows the open pattern’s steps on every row, and a row only changes where its steps differ', async () => {
    const [a, b] = channels as [ChannelId, ChannelId];
    const { makePattern } = await import('@core/model/defaults');
    const { addPattern } = await import('@core/ops/playlist');
    const { setStep } = await import('@core/ops/notes');
    const other = makePattern('Other', '#8855cc');
    s.history.transact('second pattern', (d) => {
      addPattern(d, other);
      setStep(d, other.id, a, 2, true, { rootKey: 60 });
      setStep(d, other.id, a, 6, true, { rootKey: 60 });
      setStep(d, pattern, b, 9, true, { rootKey: 60 });
    });
    const on = (id: ChannelId) =>
      [...row(id).querySelectorAll<HTMLButtonElement>('button[aria-label^="Step "]')].flatMap((el, i) => (el.getAttribute('aria-pressed') === 'true' ? [i] : []));
    await frames(2);
    await expect.poll(() => [on(a), on(b)], EVENTUALLY).toEqual([[], [9]]);
    const untouched = step(channels[2] ?? a, 0);

    s.view.getState().setCurrentPattern(other.id);
    await frames(2);
    await expect.poll(() => [on(a), on(b)], EVENTUALLY).toEqual([[2, 6], []]);
    expect(step(channels[2] ?? a, 0)).toBe(untouched); // the same button, not rebuilt

    // Painting still works on the new pattern, and lands in it.
    await userEvent.click(step(b, 3));
    expect(notesSorted(project().patterns[other.id]?.notes[b]).map((n) => n.tick / 240)).toEqual([3]);
    expect(stepsOn(b)).toEqual([9]);

    s.view.getState().setCurrentPattern(pattern);
    await frames(2);
    await expect.poll(() => [on(a), on(b)], EVENTUALLY).toEqual([[], [9]]);
    await s.history.undo();
    await s.history.undo();
  });
});
