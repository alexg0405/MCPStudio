/**
 * Versions and the project list in the real React shell (headless Chrome, test services with the fake engine and in-memory
 * version storage): the empty states, saving a named version through its dialog, restoring one from its row (one undo
 * step), the row menu (keep forever, delete asks first), the footer's numbers, and the Projects window's card, search and
 * pin. The versions are compressed in a real Worker, as in the app.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryVersionFiles } from '@app/versions/memory';
import { memoryKv } from '@app/storage/kv';
import { createTestServices } from '@app/testing';
import { closeContextMenu } from '@ui/controls/ContextMenu';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
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

describe('versions and projects (UI)', { timeout: 60_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let stop: () => void;
  const project = () => s.doc.getState().project;
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === name || el.getAttribute('aria-label') === name);
  const menuItem = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim().startsWith(text));
  const windowEl = (type: string) => host.querySelector<HTMLElement>(`[data-window="${type}"], [data-window-id="${type}"]`);
  const addClip = (bar: number) =>
    s.history.transact('Add clip', (d) => {
      const id = `clip_ui_${bar}` as never;
      d.playlist.clips[id] = {
        kind: 'pattern',
        id,
        laneId: d.playlist.laneOrder[0]!,
        patternId: d.patternOrder[0]!,
        start: bar * 3840,
        length: 3840,
        offset: 0,
      };
    });
  /** The row of a version in the Versions window, found by its "More" button. */
  const rowOf = (title: string) => document.querySelector(`button[aria-label="More for ${title}"]`)!.closest('li') as HTMLElement;
  const saveVersionNamed = async (name: string) => {
    await userEvent.click(button('Save a version…')!);
    await expect.poll(() => document.querySelector('input[placeholder="Before vocals"]'), EVENTUALLY).toBeTruthy();
    await userEvent.fill(document.querySelector<HTMLInputElement>('input[placeholder="Before vocals"]')!, name);
    await userEvent.click(button('Save version')!);
    await expect.poll(() => !!document.querySelector(`button[aria-label="More for ${name}"]`), EVENTUALLY).toBe(true);
  };

  beforeAll(async () => {
    await page.viewport(1400, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1400px;height:900px';
    document.body.append(host);
    s = createTestServices({ versionBackend: { kv: memoryKv(), files: memoryVersionFiles() }, projectSources: { recentFiles: async () => [], autosaves: async () => [], loadAutosave: async () => null } });
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    stop = s.versions.start();
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('header'));
    openWindow(s, 'versions');
    await frames(3);
  });

  afterAll(() => {
    stop();
    root.unmount();
    host.remove();
  });

  it('says what to do when there are no versions yet', async () => {
    await expect.poll(() => windowEl('versions')?.textContent ?? '', EVENTUALLY).toContain('No versions yet.');
    expect(windowEl('versions')!.textContent).toContain('Save a version…');
  });

  it('saves a named version through its dialog and lists it with what changed', async () => {
    addClip(0);
    addClip(1);
    await saveVersionNamed('Before vocals');
    const text = windowEl('versions')!.textContent ?? '';
    expect(text).toContain('Today');
    expect(text).toMatch(/1 version/);
    expect(text).not.toContain('No versions yet.');
    addClip(2);
    await saveVersionNamed('Added a clip');
    await expect.poll(() => rowOf('Added a clip').textContent ?? '', EVENTUALLY).toContain('+1 clip');
  });

  it('restores a version from its row as one undo step, and the same click can be undone', async () => {
    const steps = s.history.steps().done.length;
    const restore = [...rowOf('Before vocals').querySelectorAll('button')].find((b) => b.textContent === 'Restore')!;
    await userEvent.click(restore);
    await expect.poll(() => Object.keys(project().playlist.clips).length, EVENTUALLY).toBe(2);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    expect(s.history.status().undoLabel).toBe('Restore version “Before vocals”');
    s.history.undo();
    expect(Object.keys(project().playlist.clips)).toHaveLength(3);
  });

  it('the row menu keeps a version forever; deleting a kept one asks first', async () => {
    await userEvent.click(document.querySelector('button[aria-label="More for Added a clip"]')!);
    await userEvent.click(menuItem('Stop keeping it forever')!);
    await expect.poll(() => s.versions.view.getState().versions.find((v) => v.name === 'Added a clip')?.pinned, EVENTUALLY).toBe(false);
    closeContextMenu();
    // An unpinned version goes without a question.
    const before = s.versions.view.getState().versions.length;
    await userEvent.click(document.querySelector('button[aria-label="More for Added a clip"]')!);
    await userEvent.click(menuItem('Delete')!);
    await expect.poll(() => s.versions.view.getState().versions.length, EVENTUALLY).toBe(before - 1);
    // A pinned one asks.
    await userEvent.click(document.querySelector('button[aria-label="More for Before vocals"]')!);
    await userEvent.click(menuItem('Delete')!);
    await expect.poll(() => document.querySelector('[aria-modal="true"]')?.textContent ?? '', EVENTUALLY).toContain('is kept forever');
    await userEvent.click(button('Keep it')!);
    expect(s.versions.view.getState().versions.some((v) => v.name === 'Before vocals')).toBe(true);
  });

  it('shows how much the versions take', async () => {
    const footer = windowEl('versions')!.textContent ?? '';
    expect(footer).toMatch(/This project: 1 version, \d+ KB/);
  });

  it('lists the project with its numbers, finds it by search and pins it', async () => {
    openWindow(s, 'projects');
    await expect.poll(() => windowEl('projects')?.textContent ?? '', EVENTUALLY).toContain('1 version');
    const list = windowEl('projects')!;
    expect(list.textContent).toContain(`${project().transport.bpm} BPM`);
    expect(list.textContent).toContain('open now');
    expect(list.querySelector('canvas')).toBeTruthy();

    const search = list.querySelector<HTMLInputElement>('input[type="search"]')!;
    await userEvent.fill(search, 'zzz');
    await expect.poll(() => list.textContent ?? '', EVENTUALLY).toContain('No project matches');
    await userEvent.fill(search, `${project().transport.bpm} bpm`);
    await expect.poll(() => list.querySelectorAll('canvas').length, EVENTUALLY).toBe(1);

    await userEvent.click(button(`Pin ${project().meta.title === 'Untitled' ? 'Untitled' : project().meta.title} to the top`)!);
    await expect.poll(() => s.projects.view.getState().items[0]?.pinned, EVENTUALLY).toBe(true);
  });

  it('"Versions" on a card opens the Versions window on that project', async () => {
    const card = windowEl('projects')!;
    await userEvent.click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Versions')!);
    await expect.poll(() => !!windowEl('versions')?.textContent?.includes('Before vocals'), EVENTUALLY).toBe(true);
  });
});
