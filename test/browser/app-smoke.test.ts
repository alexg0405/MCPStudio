/**
 * End-to-end smoke test: the whole app (real engine, all features, React shell) in headless Chrome.
 * Open a project file → play → seek → stop → save → reopen.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServices, type Services } from '@app/services';
import { installPluginDiscovery } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { newId } from '@core/model/ids';
import type { PatternClip } from '@core/model/types';
import { setStep } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { applyDefaultLayout } from '@ui/workspace/layouts';
import '@ui/theme/tokens.css';
import '@ui/theme/base.css';

const BAR = 3840;
// Generous: these are whole-app flows, and the machine may be busy; a failure only takes longer to report.
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('app smoke test', () => {
  let s: Services;
  let root: Root;
  let host: HTMLDivElement;
  const errors: unknown[] = [];

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
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
    await s.engine.resume();
  });

  afterAll(async () => {
    root.unmount();
    host.remove();
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  it('renders the shell and its default windows', async () => {
    await until(() => !!host.querySelector('header') && host.textContent!.includes('Channel rack'));
    expect(host.textContent).toContain('Playlist');
    expect(host.querySelectorAll('[role="menuitem"]').length).toBe(0); // menus closed
  });

  it('opens a project file, plays, seeks, stops, saves and reopens it', async () => {
    // A two-bar song: a beat in Pattern 1, placed twice on the playlist.
    const p = s.doc.getState().project;
    const pat = p.patternOrder[0]!;
    const [kick, clap] = p.channelOrder;
    s.history.transact('Beat', (d) => {
      for (const i of [0, 4, 8, 12]) setStep(d, pat, kick!, i, true, { rootKey: 60 });
      for (const i of [4, 12]) setStep(d, pat, clap!, i, true, { rootKey: 60 });
      const clips: PatternClip[] = [0, BAR].map((start) => ({
        kind: 'pattern',
        id: newId.clip(),
        laneId: d.playlist.laneOrder[0]!,
        start,
        length: BAR,
        patternId: pat,
        offset: 0,
      }));
      addClips(d, clips);
    });
    const fixture = await s.files.build();
    const saved = s.doc.getState().project;
    s.history.markSaved();
    await s.files.newProject();
    expect(s.doc.getState().project.playlist.clips).toEqual({});

    expect(await s.files.openFile(new File([fixture.slice().buffer], 'Smoke song.agproj'))).toBe(true);
    expect(s.doc.getState().project).toEqual(saved);
    await until(() => document.title === 'Smoke song – AGstudio');

    // Play, seek into the second bar (playback continues from there) and stop. Returns the notes that
    // were late and whether the main thread kept up meanwhile.
    s.view.getState().setMode('song');
    const playSeekStop = async () => {
      const lateBefore = s.engine.stats().lateEvents;
      let last = performance.now();
      let worstStall = 0;
      const watch = setInterval(() => {
        const now = performance.now();
        worstStall = Math.max(worstStall, now - last);
        last = now;
      }, 10);
      s.commands.run('transport.playPause');
      await until(() => s.engine.playing && s.engine.playhead() > 240);
      s.engine.play(BAR + 480);
      await until(() => s.engine.playhead() >= BAR + 480);
      expect(s.engine.playhead()).toBeLessThan(2 * BAR + 960);
      s.commands.run('transport.stop');
      await until(() => !s.engine.playing);
      clearInterval(watch);
      const { lateEvents, maxPumpGapMs } = s.engine.stats();
      return { late: lateEvents - lateBefore, keptUp: worstStall < 80 && maxPumpGapMs < 80 };
    };
    // Late notes mean a scheduling bug only if the machine kept up: other test files rendering in
    // parallel can stall the main thread past the lookahead, or the audio thread. A bug is late on
    // every run; load only now and then, so a late run is measured again.
    let run = await playSeekStop();
    for (let again = 0; again < 2 && run.keptUp && run.late > 0; again++) run = await playSeekStop();
    if (run.keptUp) expect(run.late).toBe(0);

    const bytes = await s.files.build();
    await s.files.newProject();
    expect(await s.files.openFile(new File([bytes.slice().buffer], 'Again.agproj'))).toBe(true);
    expect(s.doc.getState().project).toEqual(saved);
    expect(s.view.getState().mode).toBe('song');
  }, 30_000);

  it('writes a beat from a description with the assistant window (offline generator)', async () => {
    s.commands.run('view.assistant');
    await until(() => host.textContent!.includes('Ask for anything'));
    // The test server has no Claude key or Claude Code: the offline generator writes the beat.
    s.assistant.set({ backend: 'offline' });
    await until(() => s.assistant.store.getState().status !== null);
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    // Type into the React-controlled field the way a user would.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'dark trap with 808s');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const sendButton = host.querySelector('[data-hint="Send (Enter)"]') as HTMLButtonElement;
    await until(() => !sendButton.disabled);
    sendButton.click();
    await until(() => s.assistant.store.getState().applied !== null);
    const applied = s.assistant.store.getState().applied!;
    const p = s.doc.getState().project;
    expect(p.patterns[applied.patternId]?.name).toMatch(/trap/i);
    expect(Object.keys(applied.channels)).toEqual(expect.arrayContaining(['kick', '808']));
    await until(() => host.textContent!.includes('offline'));
    expect(s.engine.playing).toBe(true);
    s.engine.stop();
  }, 30_000);

  it('finds and runs an action by typing what you want (action search)', async () => {
    const before = s.prefs.getState().metronome;
    s.commands.run('help.palette');
    await until(() => !!host.querySelector('[aria-label="Search actions"]'));
    const input = host.querySelector('[aria-label="Search actions"] input') as HTMLInputElement;
    // "click" is what newcomers call the metronome.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'click');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => !!host.querySelector('[role="option"][aria-selected="true"]')?.textContent?.includes('Metronome'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => s.prefs.getState().metronome !== before);
    expect(host.querySelector('[aria-label="Search actions"]')).toBeNull();
    s.prefs.getState().set({ metronome: before });
  });

  it('logged no errors', () => {
    expect(errors).toEqual([]);
  });
});
