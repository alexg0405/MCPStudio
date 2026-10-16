import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@app/services';
import { installStorage, storageService } from '@app/storage/service';
import { formatSize } from '@core/gc/format';
import { ServicesProvider } from '@ui/services-context';
import { DialogHost } from '@ui/controls/Dialog';
import { StorageSection } from '@ui/features/settings/StorageSection';
import { register as registerSettings } from '@ui/features/settings/register';
import { cleanupGc, env, openTab, projectOf, put, stored, supported, until } from '../helpers/gc-world';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

afterEach(cleanupGc);

describe.skipIf(!supported)('Settings → Storage', () => {
  let host: HTMLDivElement;
  let root: Root;
  let s: Services;

  beforeAll(() => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:560px;height:900px;overflow:auto';
    document.body.append(host);
  });
  afterAll(() => host.remove());
  afterEach(() => {
    root?.unmount();
    storageService()?.stop();
  });

  const text = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.textContent ?? '';

  it('shows numbers that add up, and cleans up after a confirm', async () => {
    const e = await env();
    const MB = 1024 * 1024;
    const used = await put(e, 1, 2 * MB);
    const dj = await put(e, 2, 3 * MB);
    const unusedOld = await put(e, 3, MB);
    // The song library and an autosave, as the app writes them.
    await e.kv.set([['dj-library', [{ key: dj.hash, ref: dj.ref, title: 'T', label: 'T', fileName: 't.wav', addedAt: 0 }]]]);
    s = createServices();
    registerSettings(s);
    // The app's own tab: it holds the life lock and the services publish its project (the one using `used`).
    const tab = await openTab(e, 'ui', projectOf());
    tab.refs.stop();
    s.history.load(projectOf(used.ref));
    installStorage(s, tab.id, {
      kv: e.kv,
      storage: e.storage,
      derived: { usage: async () => ({ files: 2, bytes: 5 * MB }) },
      heldTabs: e.deps().heldTabs,
      autoStartDelayMs: 24 * 60 * 60 * 1000,
      now: e.now,
    });
    root = createRoot(host);
    root.render(
      createElement(ServicesProvider, { services: s, children: [createElement(StorageSection, { key: 's' }), createElement(DialogHost, { key: 'd' })] }),
    );
    await until(() => text('storage-total') !== '' && text('storage-total') !== '…');
    const usage = await storageService()!.usage();
    expect(usage.projectAudio).toEqual({ files: 1, bytes: 2 * MB });
    expect(usage.djLibrary).toEqual({ files: 1, bytes: 3 * MB });
    expect(usage.stretched).toEqual({ files: 2, bytes: 5 * MB });
    expect(usage.other.unusedBytes).toBe(MB);
    // The rows add up to the total.
    expect(usage.total).toBe(usage.projectAudio.bytes + usage.djLibrary.bytes + usage.stretched.bytes + usage.other.bytes);
    expect(text('storage-project')).toBe('2.0 MB in 1 file');
    expect(text('storage-dj')).toBe('3.0 MB in 1 song');
    expect(text('storage-stretched')).toBe('5.0 MB in 2 copies');
    expect(text('storage-total')).toBe(formatSize(usage.total));

    // Too young to remove: nothing can go yet, and the numbers say how much is waiting.
    const preview = await storageService()!.preview();
    expect(preview).toMatchObject({ files: 0, waitingFiles: 1 });

    // A week and a bit later it can go. The button shows what would be removed and asks first.
    e.skew.days = 8;
    const clean = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Clean up unused audio…'))!;
    clean().click();
    await until(() => document.querySelector('[role="alertdialog"]') !== null);
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Remove 1 audio file (1.0 MB) that nothing uses?');
    const choose = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === label)!.click();
    // "Keep it" removes nothing.
    choose('Keep it');
    await until(() => document.querySelector('[role="alertdialog"]') === null);
    expect(await stored(e)).toContain(unusedOld.hash);
    // "Clean up" does.
    clean().click();
    await until(() => document.querySelector('[role="alertdialog"]') !== null);
    choose('Clean up');
    await until(async () => !(await stored(e)).includes(unusedOld.hash));
    expect(await stored(e)).toEqual([used.hash, dj.hash].sort());
    // The numbers are measured again and still add up; the last cleanup is shown.
    await until(() => text('storage-last-run').includes('removed 1 file'));
    const again = await storageService()!.usage();
    expect(again.other.unusedBytes).toBe(0);
    expect(again.total).toBe(usage.total - MB);
    expect(again.total).toBe(again.projectAudio.bytes + again.djLibrary.bytes + again.stretched.bytes + again.other.bytes);

    // The automatic cleanup switch is on by default and turns off.
    expect(s.prefs.getState().autoCleanup).toBe(true);
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    expect(s.prefs.getState().autoCleanup).toBe(false);
    s.prefs.getState().set({ autoCleanup: true });
    tab.close();
  });
});
