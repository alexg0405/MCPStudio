/**
 * Typing a number into a drag number (headless Chrome, the real React shell, test services with the
 * fake engine), on the transport's tempo: a click turns it into a text box; Enter or leaving it sets
 * the value as one undo step (decimals work, out-of-range values clamp, text that isn't a number is
 * ignored); Esc cancels; dragging and scrolling still change it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { setBpm } from '@core/ops/notes';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
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

// Real clicks and typing in the whole app: generous per-test time for a busy machine.
describe('typing the tempo (UI)', { timeout: 90_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  const bpm = () => s.doc.getState().project.transport.bpm;
  const box = () => host.querySelector<HTMLElement>('[data-tour="tempo"] > div');
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Tempo in BPM"]');
  const undoLabel = () => s.history.status().undoLabel;
  const typeTempo = async (text: string) => {
    await userEvent.click(box()!);
    await until(() => !!input() && document.activeElement === input());
    await userEvent.keyboard(text);
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!box());
  });

  beforeEach(async () => {
    s.history.transact('reset', (d) => setBpm(d, 120));
    await until(() => !input() && box()!.textContent === '120.000');
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('says how to change it', () => {
    expect(box()!.getAttribute('data-hint')).toMatch(/^Tempo in BPM: drag, scroll, or click to type/);
  });

  it('a click turns it into a text box; Enter sets a decimal tempo as one undo step', async () => {
    await typeTempo('140.5');
    expect(input()!.value).toBe('140.5');
    await userEvent.keyboard('{Enter}');
    await until(() => !input());
    expect(bpm()).toBe(140.5);
    expect(box()!.textContent).toBe('140.500');
    expect(undoLabel()).toBe('Tempo');
    s.history.undo();
    expect(bpm()).toBe(120);
  });

  it('clamps to 10–522', async () => {
    await typeTempo('999{Enter}');
    await until(() => !input());
    expect(bpm()).toBe(522);
    await typeTempo('3{Enter}');
    await until(() => !input());
    expect(bpm()).toBe(10);
  });

  it('ignores text that is not a number; a decimal comma and a unit are fine', async () => {
    await typeTempo('fast{Enter}');
    await until(() => !input());
    expect(bpm()).toBe(120);
    await typeTempo('97,25 bpm{Enter}');
    await until(() => !input());
    expect(bpm()).toBe(97.25);
  });

  it('Esc cancels; leaving the box sets it', async () => {
    const before = s.history.status().cursor;
    await typeTempo('90{Escape}');
    await until(() => !input());
    expect(bpm()).toBe(120);
    expect(s.history.status().cursor).toBe(before);
    await typeTempo('100');
    await userEvent.click(host.querySelector('header')!, { position: { x: 600, y: 20 } });
    await until(() => !input());
    expect(bpm()).toBe(100);
  });

  it('typing in the box runs no shortcuts', async () => {
    const tool = s.editor.getState().playlist.tool;
    // P, B, D are playlist tool keys; space plays.
    await typeTempo('pbd 1{Escape}');
    await until(() => !input());
    expect(s.editor.getState().playlist.tool).toBe(tool);
    expect(s.engine.playing).toBe(false);
  });

  it('dragging and scrolling still change it (a drag is one undo step, no text box)', async () => {
    const r = box()!.getBoundingClientRect();
    const ev = (type: string, dy: number, buttons: number) =>
      box()!.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: r.left + 10, clientY: r.top + 8 - dy }),
      );
    ev('pointerdown', 0, 1);
    for (const dy of [10, 20, 40]) ev('pointermove', dy, 1);
    ev('pointerup', 40, 0);
    await until(() => bpm() === 130);
    expect(input()).toBeNull();
    s.history.undo();
    expect(bpm()).toBe(120);
    await until(() => box()!.textContent === '120.000');
    box()!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    await until(() => bpm() === 121);
  });
});
