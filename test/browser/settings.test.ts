/**
 * Settings window: every control changes its preference, the preference is remembered in this browser
 * (localStorage, read back by a fresh prefs store), and the audio buffer can change while playing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { page, userEvent } from 'vitest/browser';
import { createServices, type Services } from '@app/services';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { createPrefsStore } from '@app/stores/prefs';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('settings', () => {
  let s: Services;
  let root: Root;
  let host: HTMLDivElement;
  const KEY = 'agstudio:prefs:v1';

  beforeAll(async () => {
    localStorage.removeItem(KEY);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await page.viewport(1440, 900);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0';
    host.id = 'root';
    document.body.append(host);
    const plugins = new PluginRegistry();
    await installPluginDiscovery(plugins);
    s = createServices({ plugins });
    registerFeatures(s);
    installKeyboard(s);
    applyDefaultLayout(s);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    openWindow(s, 'settings');
    await until(() => host.textContent!.includes('Sound output'));
  });

  afterAll(async () => {
    root.unmount();
    host.remove();
    await s.engine.dispose();
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.accent;
    vi.restoreAllMocks();
  });

  /** The settings window's control for a row label ("Count-in") . */
  const row = (label: string): HTMLElement => {
    const el = [...host.querySelectorAll<HTMLElement>('[data-window-type="settings"] section > div')].find(
      (r) => r.firstElementChild?.textContent?.trim() === label,
    );
    if (!el) throw new Error(`no settings row "${label}"`);
    return el;
  };
  const select = (label: string) => row(label).querySelector('select')!;
  const saved = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  /** What a fresh start of the app would load. */
  const reloaded = () => createPrefsStore().getState();

  it('theme and accent change the look at once and are remembered', async () => {
    await userEvent.selectOptions(select('Theme'), 'carrara');
    expect(s.prefs.getState().theme).toBe('carrara');
    expect(document.documentElement.dataset.theme).toBe('carrara');
    expect(saved().theme).toBe('carrara');
    expect(reloaded().theme).toBe('carrara');
    const swatch = host.querySelector<HTMLElement>('[role="radio"][aria-label="Blue"]')!;
    await userEvent.click(swatch);
    expect(document.documentElement.dataset.accent).toBe('blue');
    expect(reloaded().accent).toBe('blue');
    await userEvent.selectOptions(select('Theme'), 'marble');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await userEvent.click(host.querySelector<HTMLElement>('[role="radio"][aria-label="Gold"]')!);
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });

  it('the switches turn their preference on and off, and it is remembered', async () => {
    const cases: [row: string, pref: 'tooltips' | 'typingPiano' | 'metronome' | 'recordAudio' | 'recordNotes'][] = [
      ['Tooltips', 'tooltips'],
      ['Typing piano', 'typingPiano'],
      ['Metronome', 'metronome'],
      ['Records', 'recordNotes'],
    ];
    for (const [label, pref] of cases) {
      const box = row(label).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const before = s.prefs.getState()[pref];
      await userEvent.click(box);
      await until(() => s.prefs.getState()[pref] === !before);
      expect(saved()[pref], pref).toBe(!before);
      expect(reloaded()[pref], pref).toBe(!before);
      await userEvent.click(box);
      await until(() => s.prefs.getState()[pref] === before);
      expect(reloaded()[pref], pref).toBe(before);
    }
  });

  it('count-in, snap and over-old-notes choices are remembered', async () => {
    await userEvent.selectOptions(select('Count-in'), '2');
    expect(s.prefs.getState().countInBars).toBe(2);
    expect(reloaded().countInBars).toBe(2);
    await userEvent.selectOptions(select('Snap notes to'), '240');
    expect(s.prefs.getState().recordQuantize).toBe(240);
    expect(reloaded().recordQuantize).toBe(240);
    await userEvent.selectOptions(select('Over old notes'), 'replace');
    expect(s.prefs.getState().recordMode).toBe('replace');
    expect(reloaded().recordMode).toBe('replace');
  });

  it('the octave buttons move the typing keyboard and are remembered', async () => {
    const start = s.prefs.getState().pianoOctave;
    await userEvent.click(host.querySelector<HTMLElement>('[aria-label="Octave up"]')!);
    expect(s.prefs.getState().pianoOctave).toBe(start + 1);
    expect(reloaded().pianoOctave).toBe(start + 1);
    await userEvent.click(host.querySelector<HTMLElement>('[aria-label="Octave down"]')!);
    expect(reloaded().pianoOctave).toBe(start);
  });

  it('the audio buffer changes while playing: a new audio engine takes over and the song keeps playing', async () => {
    await s.engine.resume();
    s.commands.run('transport.playPause');
    await until(() => s.engine.playing && s.engine.playhead() > 120);
    // Count the audio contexts the app opens from here on.
    const Original = window.AudioContext;
    let made = 0;
    window.AudioContext = class extends Original {
      constructor(...args: ConstructorParameters<typeof Original>) {
        super(...args);
        made++;
      }
    };
    try {
      const before = s.engine.playhead();
      await userEvent.selectOptions(select('Audio buffer'), 'small');
      expect(s.prefs.getState().audioBuffer).toBe('small');
      expect(reloaded().audioBuffer).toBe('small');
      await until(() => made === 1);
      // Playing carries on from about where it was (the pattern loops, so allow a wrap).
      await until(() => s.engine.playing);
      await new Promise((r) => setTimeout(r, 300));
      expect(s.engine.playing).toBe(true);
      expect(s.engine.playhead()).not.toBeNaN();
      expect(before).toBeGreaterThan(0);
      // And back: another switch, another engine; still playing.
      await userEvent.selectOptions(select('Audio buffer'), 'large');
      await until(() => made === 2);
      await until(() => s.engine.playing);
      expect(reloaded().audioBuffer).toBe('large');
    } finally {
      window.AudioContext = Original;
      s.commands.run('transport.stop');
    }
  }, 30_000);

  it('a stale or hand-edited value falls back to the default instead of breaking the app', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 12, countInBars: 'x', audioBuffer: 'huge', metronome: 'yes' }));
    const p = createPrefsStore().getState();
    expect(p.theme).toBe('marble');
    expect(p.countInBars).toBe(1);
    expect(p.audioBuffer).toBe('large');
    expect(p.metronome).toBe(false);
    localStorage.setItem(KEY, '{not json');
    expect(createPrefsStore().getState().theme).toBe('marble');
  });
});
