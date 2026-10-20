/**
 * "Play this" buttons and menu entries (headless Chrome, the real React shell, test services with the
 * fake engine): the piano roll's and channel rack's ▶ plays the pattern being edited in pattern mode
 * and turns into ■ while it plays; the browser's pattern menu, the playlist's clip, marker, empty-spot and
 * ruler menus and the action search start playback from the right place, without the toolbar's play button.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { addMarkerAt } from '@app/actions/markers';
import { makePattern } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ChannelId, Clip, LaneId, PatternId } from '@core/model/types';
import { addClips, addPattern, removeClips } from '@core/ops/playlist';
import { registerFeatures } from '@ui/features';
import { closeContextMenu, showContextMenu } from '@ui/controls/ContextMenu';
import { clipMenu } from '@ui/features/playlist/menus';
import { markerMenu, rulerMenu } from '@ui/features/playlist/markers';
import { emptyMenu } from '@ui/features/playlist/empty-menu';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { openWindow } from '@ui/workspace/registry';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { EVENTUALLY, untilStill } from '../helpers/wait';

const BAR = 3840;
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

describe('play buttons and menus (UI)', { timeout: 30_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let verse: PatternId;
  let chorus: PatternId;
  let lane: LaneId;
  let commits = 0;
  const loop = () => s.view.getState().loop;
  const win = (type: string) => host.querySelector<HTMLElement>(`[data-window-type="${type}"]`)!;
  const playButton = (type: string) => win(type)?.querySelector<HTMLButtonElement>('button[data-play-pattern]') as HTMLButtonElement;
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((b) => b.textContent?.includes(label));
  /** Clicks a menu entry like the user does. */
  const choose = async (label: string) => {
    await until(() => !!menuItem(label));
    menuItem(label)!.click();
    await frames(2);
  };
  const addClip = (patternBar: number, bars: number): Clip => {
    const clip: Clip = { kind: 'pattern', id: newId.clip(), laneId: lane, start: patternBar * BAR, length: bars * BAR, patternId: verse, offset: 0 };
    s.history.transact('clip', (d) => addClips(d, [clip]));
    return clip;
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    const p = s.doc.getState().project;
    verse = p.patternOrder[0] as PatternId;
    chorus = newId.pattern();
    s.history.transact('second pattern', (d) => addPattern(d, makePattern('Chorus', '#4aa3ff', chorus), 1));
    lane = p.playlist.laneOrder[0] as LaneId;
    const channel = Object.values(p.channels).find((c) => c.kind === 'instrument')!.id as ChannelId;
    s.session.getState().selectChannel(channel);
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'piano-roll');
    openWindow(s, 'channel-rack');
    root = createRoot(host);
    root.render(
      createElement(
        Profiler,
        { id: 'app', onRender: () => commits++ },
        createElement(ServicesProvider, { services: s, children: createElement(App) }),
      ),
    );
    await until(() => !!playButton('piano-roll') && !!playButton('channel-rack'));
    await frames(3);
  });

  beforeEach(async () => {
    closeContextMenu();
    s.engine.stop();
    s.view.getState().setLoop(null);
    s.view.getState().setMode('song');
    s.view.getState().setCurrentPattern(verse);
    const ids = Object.keys(s.doc.getState().project.playlist.clips) as Clip['id'][];
    if (ids.length) s.history.transact('clear', (d) => removeClips(d, ids));
    await frames(2);
  });

  afterAll(() => {
    s.engine.stop();
    root.unmount();
    host.remove();
  });

  it('the piano roll ▶ loops the pattern being edited in pattern mode and turns into ■; ■ stops it', async () => {
    s.view.getState().setCurrentPattern(chorus);
    await frames(2);
    const button = playButton('piano-roll');
    expect(button.getAttribute('data-hint')).toBe('Play this pattern on a loop (Space plays whatever is selected)');
    expect(button.getAttribute('aria-label')).toBe('Play pattern');
    button.click();
    await until(() => s.fakeEngine.playing);
    expect(s.view.getState().mode).toBe('pattern');
    expect(s.view.getState().currentPatternId).toBe(chorus);
    expect(s.fakeEngine.lastPlayFrom).toBe(0);
    await until(() => playButton('piano-roll').getAttribute('aria-label') === 'Stop');
    // The channel rack's button shows the same state.
    expect(playButton('channel-rack').getAttribute('aria-label')).toBe('Stop');
    playButton('piano-roll').click();
    await until(() => !s.fakeEngine.playing);
    await until(() => playButton('piano-roll').getAttribute('aria-label') === 'Play pattern');
    expect(playButton('channel-rack').getAttribute('aria-label')).toBe('Play pattern');
  });

  it('the channel rack ▶ plays the current pattern too; the buttons show ▶ again when the song plays instead', async () => {
    playButton('channel-rack').click();
    await until(() => s.fakeEngine.playing);
    expect(s.view.getState().mode).toBe('pattern');
    expect(s.view.getState().currentPatternId).toBe(verse);
    await until(() => playButton('channel-rack').getAttribute('aria-label') === 'Stop');
    // Another pattern becomes the one that loops (and is being edited): still ■.
    s.view.getState().setCurrentPattern(chorus);
    await frames(3);
    await expect.poll(() => playButton('channel-rack').getAttribute('aria-label'), EVENTUALLY).toBe('Stop');
    // Song mode plays the playlist, not this pattern.
    s.view.getState().setMode('song');
    await until(() => playButton('channel-rack').getAttribute('aria-label') === 'Play pattern');
    expect(playButton('piano-roll').getAttribute('aria-label')).toBe('Play pattern');
  });

  it('the buttons cause no React commits while the playhead moves', async () => {
    playButton('piano-roll').click();
    await until(() => s.fakeEngine.playing);
    await frames(3);
    const label = playButton('piano-roll');
    const seen: string[] = [];
    const watch = new MutationObserver((records) => records.forEach((r) => seen.push(r.type)));
    watch.observe(label, { attributes: true, childList: true, subtree: true });
    s.fakeEngine.startTick = 3 * BAR;
    await frames(30);
    watch.disconnect();
    expect(seen).toEqual([]);
  });

  it('the toolbar shifting by a pixel while playing does not re-render anything', async () => {
    playButton('piano-roll').click();
    await until(() => s.fakeEngine.playing);
    await untilStill(() => commits);
    const group = host.querySelector<HTMLElement>('[data-slot]')!.parentElement!;
    const before = commits;
    // The position readout changing width resizes the toolbar's centre group by a pixel or so.
    group.parentElement!.style.paddingRight = '1px';
    await frames(5);
    group.parentElement!.style.paddingRight = '3px';
    await frames(5);
    group.parentElement!.style.paddingRight = '';
    await frames(5);
    await expect.poll(() => commits - before, EVENTUALLY).toBe(0);
  });

  it('the browser’s pattern menu plays a pattern, and says Stop while it plays', async () => {
    const row = () =>
      [...host.querySelectorAll<HTMLElement>('button[data-hint]')].find((b) => b.getAttribute('data-hint')?.startsWith('Chorus:'))!;
    await until(() => !!row());
    row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 200 }));
    await choose('Play');
    await until(() => s.fakeEngine.playing);
    expect(s.view.getState().currentPatternId).toBe(chorus);
    expect(s.view.getState().mode).toBe('pattern');
    row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 200 }));
    await until(() => !!menuItem('Stop'));
    expect(menuItem('Play')).toBeUndefined();
    await choose('Stop');
    expect(s.fakeEngine.playing).toBe(false);
  });

  it('the clip menu’s “Play this clip” loops the clip’s span in song mode', async () => {
    const clip = addClip(4, 2);
    showContextMenu({ x: 200, y: 200 }, clipMenu(s, clip));
    await choose('Play this clip');
    expect(loop()).toEqual({ start: 4 * BAR, end: 6 * BAR });
    expect(s.view.getState().mode).toBe('song');
    expect(s.fakeEngine.playing).toBe(true);
    expect(s.fakeEngine.lastPlayFrom).toBe(4 * BAR);
  });

  it('the clip menu’s “Play from here” plays the song from the clip’s start and clears a loop that excludes it', async () => {
    const clip = addClip(10, 2);
    s.view.getState().setLoop({ start: 0, end: 2 * BAR });
    showContextMenu({ x: 200, y: 200 }, clipMenu(s, clip));
    await choose('Play from here');
    expect(s.fakeEngine.lastPlayFrom).toBe(10 * BAR);
    expect(loop()).toBeNull();
    expect(s.view.getState().mode).toBe('song');
  });

  it('the marker menu’s “Play this section” loops from the marker to the next one', async () => {
    const intro = addMarkerAt(s, 4 * BAR, 'Verse');
    addMarkerAt(s, 8 * BAR, 'Chorus');
    showContextMenu({ x: 200, y: 200 }, markerMenu(s, intro));
    await choose('Play this section');
    expect(loop()).toEqual({ start: 4 * BAR, end: 8 * BAR });
    expect(s.fakeEngine.lastPlayFrom).toBe(4 * BAR);
    expect(s.view.getState().mode).toBe('song');
  });

  it('the empty-spot menu’s “Play from bar N” plays from the start of that bar', async () => {
    showContextMenu({ x: 200, y: 200 }, emptyMenu(s, 6 * BAR + 960, lane, () => {}));
    await choose('Play from bar 7');
    expect(s.fakeEngine.lastPlayFrom).toBe(6 * BAR);
    expect(s.view.getState().mode).toBe('song');
  });

  it('the ruler menu’s “Play from here” plays from that position', async () => {
    showContextMenu({ x: 200, y: 200 }, rulerMenu(s, 3 * BAR));
    await choose('Play from here');
    expect(s.fakeEngine.lastPlayFrom).toBe(3 * BAR);
  });

  it('the commands do the same, have plain hints, and show up in the command list', () => {
    for (const id of ['transport.playPattern', 'transport.playFrom', 'transport.playRange']) {
      const def = s.commands.get(id);
      expect(def?.hint, id).toBeTruthy();
      expect(def?.argsHint, id).toBeTruthy();
    }
    s.commands.run('transport.playPattern', { patternId: chorus });
    expect(s.view.getState().currentPatternId).toBe(chorus);
    expect(s.view.getState().mode).toBe('pattern');
    s.commands.run('transport.playPattern', s.doc.getState().project.patterns[verse]!.name.toUpperCase());
    expect(s.view.getState().currentPatternId).toBe(verse);
    s.commands.run('transport.playRange', { fromBar: 2, toBar: 3 });
    expect(loop()).toEqual({ start: BAR, end: 3 * BAR });
    expect(s.fakeEngine.lastPlayFrom).toBe(BAR);
    s.commands.run('transport.playFrom', { bar: 5 });
    expect(s.fakeEngine.lastPlayFrom).toBe(4 * BAR);
    expect(loop()).toBeNull();
  });
});
