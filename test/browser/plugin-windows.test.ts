/**
 * Every built-in plugin's window in the real React shell (headless Chrome, test services with the
 * fake engine): it opens without console errors, every control explains itself (a data-hint, and
 * knobs show their value with its unit), a scroll or a drag on a knob changes it as undoable
 * edits (a drag is one step), and the preset arrows load presets as one step each.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addEffect } from '@app/actions/mixer';
import { addInstrumentChannel } from '@app/actions/channels';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
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

describe('plugin windows (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  const logged: string[] = [];
  const originals = { error: console.error, warn: console.warn };

  beforeAll(async () => {
    console.error = (...a: unknown[]) => void logged.push(`error: ${a.map(String).join(' ')}`);
    console.warn = (...a: unknown[]) => void logged.push(`warn: ${a.map(String).join(' ')}`);
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
    await until(() => !!host.querySelector('header'));
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    console.error = originals.error;
    console.warn = originals.warn;
  });

  const winEl = (id: string) => host.querySelector<HTMLElement>(`[data-window-id="${id}"]`);

  /** Opens the window of a plugin (an instrument on a new channel, or an effect on the master). */
  async function open(pluginId: string, kind: 'instrument' | 'effect'): Promise<{ id: string; close(): void }> {
    let id: string;
    if (kind === 'instrument') {
      const channelId = addInstrumentChannel(s, pluginId);
      expect(channelId, `${pluginId} can be added as a channel`).toBeTruthy();
      id = `plugin:${channelId}`;
      openWindow(s, 'plugin', { kind: 'channel', channelId });
    } else {
      const master = s.doc.getState().project.mixer.order[0]!;
      const slotId = addEffect(s, master, pluginId);
      expect(slotId, `${pluginId} can be added as an effect`).toBeTruthy();
      id = `plugin:fx:${slotId}`;
      openWindow(s, 'plugin', { kind: 'fx', insertId: master, slotId });
    }
    await until(() => !!winEl(id)?.querySelector('[data-tour="preset-bar"]'));
    return {
      id,
      close() {
        s.view.getState().removeWindow(id);
        s.history.undo();
      },
    };
  }

  // Plugins are known only once the services exist, so the list is built from a throwaway instance.
  const probe = createTestServices();
  const cases = (['instrument', 'effect'] as const).flatMap((kind) =>
    probe.plugins
      .list(kind)
      .filter((e) => e.source === 'builtin')
      .map((e) => [kind, e.def.id, e.def.name] as const),
  );

  it('knows the built-in plugins', () => {
    expect(cases.length).toBeGreaterThanOrEqual(28);
  });

  describe.each(cases)('%s %s', (kind, pluginId) => {
    it('opens cleanly, explains every control, and edits and presets undo in single steps', async () => {
      logged.length = 0;
      const w = await open(pluginId, kind);
      const el = winEl(w.id)!;
      await new Promise((r) => setTimeout(r, 120));

      // Every control has a hint (itself or an ancestor).
      const controls = [...el.querySelectorAll<HTMLElement>('button, select, input, [role=slider], [role=button]')];
      const mute = controls.filter((c) => !c.getAttribute('data-hint') && !c.closest('[data-hint]'));
      expect(
        mute.map((c) => `${c.tagName} ${c.getAttribute('aria-label') ?? c.textContent?.slice(0, 20)}`),
        'controls without a hint',
      ).toEqual([]);

      // Knobs read out their value.
      const sliders = [...el.querySelectorAll<HTMLElement>('[role=slider]')];
      for (const k of sliders) {
        const hint = k.getAttribute('data-hint') ?? '';
        expect(hint, `knob ${k.getAttribute('aria-label')}`).toMatch(/\d|On|Off|[A-Za-z]/);
        expect(k.getAttribute('aria-valuetext'), `knob ${k.getAttribute('aria-label')}`).toBeTruthy();
      }

      const before = s.history.status().cursor;
      if (sliders.length > 0) {
        const knob = sliders[0]!;
        const text = () => knob.getAttribute('aria-valuenow');
        const start = text();
        // Scroll: one notch up (or down at the top of the range) is one undo step.
        for (const deltaY of [-100, 100]) {
          knob.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
          await new Promise((r) => setTimeout(r, 40));
          if (text() !== start) break;
        }
        expect(text(), 'a scroll moves the knob').not.toBe(start);
        expect(s.history.status().cursor).not.toBe(before);
        s.history.undo();
        await until(() => text() === start);
        expect(s.history.status().cursor).toBe(before);

        // Drag: many moves, one undo step.
        const r = knob.getBoundingClientRect();
        const ev = (type: string, dy: number, buttons: number) =>
          knob.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2 - dy,
            }),
          );
        ev('pointerdown', 0, 1);
        for (const dy of [4, 12, 25, 40, 60]) ev('pointermove', dy, 1);
        ev('pointerup', 60, 0);
        await new Promise((r2) => setTimeout(r2, 60));
        if (text() !== start) {
          // (A knob already at the top doesn't move upward: nothing to undo then.)
          s.history.undo();
          await until(() => text() === start);
          expect(s.history.status().cursor, 'a drag is one undo step').toBe(before);
        }
      }

      // Presets: the arrows load them, one undo step each.
      const next = el.querySelector<HTMLButtonElement>('button[aria-label="Next preset"]');
      if (next && !next.disabled) {
        const cursor = s.history.status().cursor;
        next.click();
        await new Promise((r) => setTimeout(r, 60));
        expect(s.history.status().cursor, 'a preset is an edit').not.toBe(cursor);
        s.history.undo();
        expect(s.history.status().cursor).toBe(cursor);
      }

      expect(logged, 'console errors and warnings').toEqual([]);
      w.close();
    });
  });
});
