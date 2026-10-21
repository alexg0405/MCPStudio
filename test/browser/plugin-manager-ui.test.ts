/**
 * My plugins in the real React shell (headless Chrome, test services with the fake engine and an in-memory plugin server):
 * the empty state, the gallery's install dialog (what the plugin can and cannot do, Cancel installs nothing), installing,
 * a plugin with the same id (asks instead of overwriting), sharing, switching off with what stops sounding, deleting to the
 * trash and restoring, and changing an id with the song following.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { makePluginInstance } from '@core/model/defaults';
import { MASTER } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { createTestServices } from '@app/testing';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { memoryPluginServer } from '../helpers/plugin-memory-server';
import { EVENTUALLY } from '../helpers/wait';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

const until = async (ok: () => boolean, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('My plugins (UI)', { timeout: 90_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  const registry = new PluginRegistry();
  const server = memoryPluginServer(registry);

  const manager = () => host.querySelector<HTMLElement>('[data-window-id="plugin-manager"]');
  const dialog = () => document.querySelector<HTMLElement>('[aria-modal="true"]');
  const buttonIn = (scope: ParentNode | null, name: string) =>
    [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((el) => el.textContent?.trim() === name || el.getAttribute('aria-label') === name);
  const galleryRow = (id: string) => manager()!.querySelector<HTMLElement>(`[data-gallery-id="${id}"]`)!;
  const pluginRow = (id: string) => manager()?.querySelector<HTMLElement>(`[data-plugin-id="${id}"]`) ?? null;
  const answer = async (name: string) => {
    await userEvent.click(buttonIn(dialog(), name)!);
    await expect.poll(() => dialog(), EVENTUALLY).toBeNull();
  };
  const toasts = () => s.session.getState().toasts.map((t) => t.text);

  beforeAll(async () => {
    await page.viewport(1400, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1400px;height:900px';
    document.body.append(host);
    registerBuiltinPlugins(registry);
    s = createTestServices({ plugins: registry, pluginServer: server });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    openWindow(s, 'plugin-manager');
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('says what to do when you have no plugins of your own, and offers the gallery', async () => {
    await expect.poll(() => manager()?.textContent ?? '', EVENTUALLY).toContain('You have no plugins of your own yet.');
    expect(manager()!.textContent).toContain('Import a plugin…');
    // The gallery's files load when the window opens.
    for (const name of ['Tape Stop', 'Bit Crusher', 'FM Bell', 'Wobble Filter']) await expect.poll(() => manager()!.textContent ?? '', EVENTUALLY).toContain(name);
  });

  it('shows what a gallery plugin can and cannot do before installing, and Cancel installs nothing', async () => {
    await userEvent.click(buttonIn(galleryRow('user.tape-stop'), 'Install')!);
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('Install “Tape Stop”?');
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('Tape Stop is an effect by AGstudio');
    expect(text).toContain('What it can do');
    expect(text).toContain('What it cannot do');
    expect(text).toContain('It does not use the network');
    expect(text).toContain('not a sandbox');
    await answer('Cancel');
    expect(server.installed.size).toBe(0);
    expect(pluginRow('user.tape-stop')).toBeNull();
  });

  it('installs it after the musician says yes, loads it and lists it under Your plugins', async () => {
    await userEvent.click(buttonIn(galleryRow('user.tape-stop'), 'Install')!);
    await expect.poll(() => dialog(), EVENTUALLY).toBeTruthy();
    await answer('Install');
    await expect.poll(() => pluginRow('user.tape-stop'), EVENTUALLY).toBeTruthy();
    expect(pluginRow('user.tape-stop')!.textContent).toContain('Tape Stop');
    expect(registry.get('user.tape-stop')).toBeDefined();
    expect(toasts().some((text) => text.includes('Installed “Tape Stop”'))).toBe(true);
    expect(buttonIn(galleryRow('user.tape-stop'), 'Installed')!.disabled).toBe(true);
  });

  it('says the same plugin is already installed when it is asked for again, and changes nothing', async () => {
    await s.commands.run('plugins.import', 'Tape Stop');
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('This exact plugin is already installed');
    await answer('Close');
    expect(server.installed.size).toBe(1);
  });

  it('does not overwrite a different plugin with the same id: it offers a copy or a replace', async () => {
    const original = server.installed.get('tape-stop')!;
    server.installed.set('tape-stop', { ...original, 'index.ts': `${original['index.ts']}\n// my own change\n` });
    await s.userPlugins.refresh();
    await s.commands.run('plugins.import', 'Tape Stop');
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('You already have a different plugin');
    expect(buttonIn(dialog(), 'Install as a copy')).toBeTruthy();
    expect(buttonIn(dialog(), 'Replace') ?? buttonIn(dialog(), 'Update')).toBeTruthy();
    await answer('Install as a copy');
    await expect.poll(() => pluginRow('user.tape-stop-2'), EVENTUALLY).toBeTruthy();
    expect(pluginRow('user.tape-stop-2')!.textContent).toContain('Tape Stop (copy)');
    expect(server.installed.get('tape-stop')!['index.ts']).toContain('my own change');
  });

  it('shares a plugin through its dialog and names the file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await userEvent.click(buttonIn(pluginRow('user.tape-stop'), 'Share…')!);
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('Share “Tape Stop”');
    await userEvent.fill(dialog()!.querySelector<HTMLInputElement>('input')!, 'Alex');
    await userEvent.click(buttonIn(dialog(), 'Save file')!);
    await expect.poll(() => toasts().some((text) => text.includes('Saved Tape Stop.agplugin')), EVENTUALLY).toBe(true);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    await expect.poll(() => pluginRow('user.tape-stop')!.textContent ?? '', EVENTUALLY).toContain('by Alex');
  });

  it('switches a plugin off after saying what goes silent, and back on', async () => {
    s.history.transact('Use it', (d) => void addFxSlot(d, MASTER, makePluginInstance('user.tape-stop', 1, {})));
    await expect.poll(() => pluginRow('user.tape-stop')!.textContent ?? '', EVENTUALLY).toContain('Used in 1 place in this song');
    await userEvent.click(buttonIn(pluginRow('user.tape-stop'), 'More for Tape Stop')!);
    await userEvent.click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.startsWith('Switch off'))!);
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('go silent until you switch it back on');
    await answer('Switch off');
    await expect.poll(() => pluginRow('user.tape-stop')!.textContent ?? '', EVENTUALLY).toContain('switched off');
    expect(registry.get('user.tape-stop')).toBeUndefined();
    await userEvent.click(buttonIn(pluginRow('user.tape-stop'), 'Switch on')!);
    await expect.poll(() => registry.get('user.tape-stop'), EVENTUALLY).toBeDefined();
  });

  it('changes an id with the song following, and undo brings the song back', async () => {
    const before = s.doc.getState().project;
    await s.commands.run('plugins.changeId', { plugin: 'user.tape-stop', id: 'user.tape-halt' });
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('Change the id of “Tape Stop”');
    await userEvent.click(buttonIn(dialog(), 'Change id')!);
    await expect.poll(() => s.doc.getState().project.mixer.inserts[MASTER]!.fx[0]!.plugin.pluginId, EVENTUALLY).toBe('user.tape-halt');
    expect(registry.get('user.tape-halt')).toBeDefined();
    expect(server.trashed.size).toBe(1);
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('deletes to the trash after a warning and restores from there', async () => {
    await s.commands.run('plugins.delete', 'user.tape-stop-2');
    await expect.poll(() => dialog()?.textContent ?? '', EVENTUALLY).toContain('plugins/_trash');
    await answer('Delete');
    await expect.poll(() => pluginRow('user.tape-stop-2'), EVENTUALLY).toBeNull();
    await expect.poll(() => manager()!.textContent ?? '', EVENTUALLY).toContain('Trash');
    const restore = [...manager()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Restore' && b.closest('li')?.textContent?.includes('tape-stop-2'));
    await userEvent.click(restore!);
    await expect.poll(() => pluginRow('user.tape-stop-2'), EVENTUALLY).toBeTruthy();
  });
});
