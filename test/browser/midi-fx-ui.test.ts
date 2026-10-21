/**
 * The MIDI effects window and its neighbours in the real React shell (headless Chrome, test services with the fake engine): the
 * empty window says what to do, adding, bypassing, moving (buttons, keys, drag) and removing are each one undo step, presets and
 * chains load, the badge in the channel rack and the foot of the instrument's window follow the chain, and every control is named.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addInstrumentChannel } from '@app/actions/channels';
import { midiFxOf } from '@core/query/midi-fx';
import type { ChannelId } from '@core/model/types';
import { registerFeatures } from '@ui/features';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { nameProblems } from '../helpers/aria-audit';

const until = async (ok: () => boolean, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 16));
  }
};

describe('MIDI effects (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let channelId: ChannelId;
  const logged: string[] = [];
  const originals = { error: console.error, warn: console.warn };

  const win = () => host.querySelector<HTMLElement>('[data-window-type="midi-fx"]')!;
  const chain = () => midiFxOf(s.doc.getState().project.channels[channelId]);
  const effects = () => chain().map((slot) => slot.effect);
  const cards = () => [...win().querySelectorAll<HTMLElement>('ol li')];
  const button = (label: string) => [...win().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!;
  const clickMenu = async (label: string) => {
    await until(() => !!document.querySelector('[role="menu"]'));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menu"] button')].find((el) => el.textContent?.trim() === label);
    expect(item, `menu item “${label}”`).toBeTruthy();
    item!.click();
  };

  beforeAll(async () => {
    console.error = (...a: unknown[]) => void logged.push(`error: ${a.map(String).join(' ')}`);
    console.warn = (...a: unknown[]) => void logged.push(`warn: ${a.map(String).join(' ')}`);
    await page.viewport(1280, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:900px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    channelId = addInstrumentChannel(s, 'agstudio.3xosc') as ChannelId;
    s.session.getState().selectChannel(channelId);
    openWindow(s, 'channel-rack');
    openWindow(s, 'midi-fx');
    await until(() => !!win()?.querySelector('[role="toolbar"]'));
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    console.error = originals.error;
    console.warn = originals.warn;
  });

  it('says what MIDI effects are and offers the first ones when the chain is empty', () => {
    expect(win().textContent).toMatch(/No MIDI effects on/);
    expect(win().textContent).toMatch(/change the notes on their way to the instrument/);
    expect(button('Arpeggiator')).toBeTruthy();
    expect(button('Render to notes').disabled).toBe(true);
  });

  it('adds effects, each one undo step, and the rack row shows a badge', async () => {
    const steps = s.history.steps().done.length;
    button('Arpeggiator').click();
    await until(() => cards().length === 1);
    button('+ Add effect ▾').click();
    await clickMenu('Chord');
    await until(() => cards().length === 2);
    expect(effects()).toEqual(['arp', 'chord']);
    expect(s.history.steps().done.length).toBe(steps + 2);
    const badge = host.querySelector<HTMLElement>(`[data-channel-id="${channelId}"] button[aria-label^="MIDI effects of"]`);
    expect(badge?.textContent).toBe('ARP+1');
    expect(button('Render to notes').disabled).toBe(false);
  });

  it('bypass, move earlier or later and the keyboard are each one step; the cards say which is which', async () => {
    const before = s.history.steps().done.length;
    button('Enable Arpeggiator').click();
    await until(() => chain()[0]!.enabled === false);
    expect(cards()[0]!.getAttribute('aria-label')).toBe('Arpeggiator, effect 1 of 2, bypassed');
    button('Enable Arpeggiator').click();
    await until(() => chain()[0]!.enabled === true);
    button('Move Chord earlier').click();
    await until(() => effects()[0] === 'chord');
    expect(button('Move Chord earlier').disabled).toBe(true);
    const header = cards()[1]!.querySelector<HTMLElement>('[draggable="true"]')!;
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, shiftKey: true, bubbles: true }));
    await until(() => effects()[0] === 'arp');
    expect(s.history.steps().done.length).toBe(before + 4);
    s.history.undo();
    await until(() => effects()[0] === 'chord');
  });

  it('dragging an effect by its header puts it where it is dropped', async () => {
    expect(effects()).toEqual(['chord', 'arp']);
    const [first, second] = cards();
    const data = new DataTransfer();
    const source = second!.querySelector<HTMLElement>('[draggable="true"]')!;
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    const box = first!.getBoundingClientRect();
    first!.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: box.top + 2 }));
    await until(() => first!.className.includes('dropBefore'));
    first!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    await until(() => effects()[0] === 'arp');
    expect(effects()).toEqual(['arp', 'chord']);
  });

  it('loads a preset and a chain, and the chain replaces the effects in one step that undo brings back', async () => {
    button('Arpeggiator presets').click();
    await clickMenu('Trance gate');
    await until(() => chain()[0]!.params.velocity === 'accent');
    const before = s.history.steps().done.length;
    button('Chains ▾').click();
    await clickMenu('Dub echo');
    // Replacing effects asks first.
    await until(() => !!document.querySelector('[role="dialog"], [role="alertdialog"]'));
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.textContent === 'Replace')!.click();
    await until(() => effects().join() === 'echo');
    expect(s.history.steps().done.length).toBe(before + 1);
    s.history.undo();
    await until(() => effects().join() === 'arp,chord');
  });

  it('every control of the populated window has a name and a hint, and nothing was logged', () => {
    expect(nameProblems(win())).toEqual([]);
    const mute = [...win().querySelectorAll<HTMLElement>('button, select, input, [role=slider], [role=button]')].filter((c) => !c.getAttribute('data-hint') && !c.closest('[data-hint]'));
    expect(mute.map((c) => `${c.tagName} ${c.getAttribute('aria-label') ?? c.textContent?.slice(0, 20)}`)).toEqual([]);
    expect(logged.filter((line) => !/ResizeObserver|Download the React DevTools/.test(line))).toEqual([]);
  });

  it('the instrument’s own window has the effects at its foot, open because there are some, and folds away', async () => {
    openWindow(s, 'plugin', { kind: 'channel', channelId });
    const plugin = () => host.querySelector<HTMLElement>(`[data-window-id="plugin:${channelId}"]`)!;
    await until(() => !!plugin()?.querySelector('section[aria-label="MIDI effects"]'));
    const section = plugin().querySelector<HTMLElement>('section[aria-label="MIDI effects"]')!;
    const bar = section.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    expect(section.textContent).toMatch(/Arpeggiator → Chord/);
    bar.click();
    await until(() => bar.getAttribute('aria-expanded') === 'false');
    expect(section.querySelector('ol')).toBeNull();
  });

  it('removing the last effects brings the empty window back and the badge goes', async () => {
    closeContextMenu();
    button('Remove Arpeggiator').click();
    await until(() => effects().length === 1);
    button('Remove Chord').click();
    await until(() => effects().length === 0);
    await until(() => /No MIDI effects on/.test(win().textContent ?? ''));
    expect(host.querySelector(`[data-channel-id="${channelId}"] button[aria-label^="MIDI effects of"]`)).toBeNull();
  });
});
