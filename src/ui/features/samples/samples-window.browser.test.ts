/**
 * The sample browser window in real Chrome: a folder of 5000 sounds scrolls without drawing every row, the filters and the
 * search narrow it, the keyboard steps through and auditions, empty states say what to do, every control explains itself,
 * and a kit can be made from the selection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { encodeWav } from '@core/io/wav';
import type { InstrumentChannel } from '@core/model/types';
import { createTestServices } from '@app/testing';
import { sampleFolders } from '@app/persistence/sample-folders';
import { memoryBrowserStorage } from '@app/samples/storage';
import type { BrowserRow } from '@app/samples/browser';
import { SAMPLE_ANALYSIS_VERSION, SAMPLE_CATEGORIES, type SampleAnalysis } from '@core/samples/types';
import { ContextMenuHost } from '@ui/controls/ContextMenu';
import { ServicesProvider } from '@ui/services-context';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';
import { SampleBrowserWindow } from './SampleBrowserWindow';
import { EMPTY_NO_AUDIO_TEXT, EMPTY_NO_FOLDERS_TEXT, EMPTY_NO_MATCH_TEXT, ROW_H } from './view';
import { EVENTUALLY } from '../../../../test/helpers/wait';

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

const tone = new File([encodeWav([Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 8) * 0.5)], 44100, { bitDepth: 16 }).slice().buffer], 'x.wav');
const handle = { getFile: () => Promise.resolve(tone) };
/** The folder's file list, one array: the model reads a folder again only when this changes, so the rows these tests set stay. */
const NO_FILES: never[] = [];
const folder = (files: never[] = NO_FILES) => ({ key: 'dir_fake', name: 'Fake', access: 'granted' as const, files, loading: false });

const analysisOf = (i: number): SampleAnalysis => {
  const loop = i % 11 === 0;
  const category = SAMPLE_CATEGORIES[i % SAMPLE_CATEGORIES.length]!;
  return {
    v: SAMPLE_ANALYSIS_VERSION,
    kind: loop ? 'loop' : 'one-shot',
    durationSec: loop ? 4 : 0.3,
    category: loop ? null : category,
    confidence: 0.9,
    ...(loop ? { bpm: 80 + (i % 90), bars: 4, loopKind: 'drums' as const } : {}),
    ...(!loop && (category === 'tonal' || category === '808') ? { root: i % 12, midi: 40 + (i % 12), keyConfidence: 0.9 } : {}),
    loudnessDb: -12,
    peakDb: -1,
    brightness: 1000,
    vec: [],
  };
};

const makeRows = (n: number): BrowserRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `dir_fake:Pack ${i % 10}/Sound ${String(i).padStart(4, '0')}.wav`,
    name: `Sound ${String(i).padStart(4, '0')}`,
    folder: 'Fake',
    folderKey: 'dir_fake',
    path: `Pack ${i % 10}/Sound ${String(i).padStart(4, '0')}.wav`,
    handle,
    analysis: analysisOf(i),
    state: 'ready',
    favorite: false,
    userTags: [],
    lastUsed: 0,
  }));

describe('Sample browser window (UI)', { timeout: 60_000 }, () => {
  let root: Root;
  let host: HTMLDivElement;
  let s: ReturnType<typeof createTestServices>;

  const list = () => host.querySelector<HTMLElement>('[role="listbox"]')!;
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-sample-row]')];
  const footer = () => host.textContent ?? '';
  const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  const chip = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.firstChild?.textContent ?? b.textContent ?? '').trim() === label)!;
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

  /** Puts fake rows in the model (after the folder's own, empty, listing has been read, so it cannot replace them). */
  const setRows = async (list: BrowserRow[], extra: Record<string, unknown> = {}) => {
    sampleFolders.setState({ folders: [folder()], loaded: true });
    await s.sampleBrowser.whenIdle();
    await new Promise((r) => setTimeout(r, 0));
    s.sampleBrowser.store.setState({ rows: list, ready: true, ...extra } as never);
  };

  beforeAll(async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:620px;display:flex;flex-direction:column';
    document.body.append(host);
    s = createTestServices({ sampleBrowser: { storage: memoryBrowserStorage(), folders: sampleFolders as never } });
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: [createElement(SampleBrowserWindow, { key: 'w' }), createElement(ContextMenuHost, { key: 'm' })] }));
    await frames(3);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
    sampleFolders.setState({ folders: [], loaded: true });
  });

  afterEach(async () => {
    s.sampleBrowser.clearFilter();
    s.sampleBrowser.setSelection([]);
    await frames(2);
  });

  it('with no folders it says what to do', async () => {
    sampleFolders.setState({ folders: [], loaded: true });
    s.sampleBrowser.store.setState({ rows: [] });
    await frames(3);
    await expect.poll(() => host.textContent, EVENTUALLY).toContain('No sample folders yet');
    expect(host.textContent).toContain(EMPTY_NO_FOLDERS_TEXT.slice(0, 40));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('a folder without audio says so', async () => {
    sampleFolders.setState({ folders: [folder()], loaded: true });
    await frames(3);
    await expect.poll(() => host.textContent, EVENTUALLY).toContain('No audio found');
    expect(host.textContent).toContain(EMPTY_NO_AUDIO_TEXT.slice(0, 30));
  });

  it('draws a window of 5000 sounds, and every row is reachable by scrolling', async () => {
    await setRows(makeRows(5000));
    await frames(4);
    await expect.poll(() => rows().length, EVENTUALLY).toBeGreaterThan(8);
    expect(rows().length).toBeLessThan(80);
    expect(rows()[0]!.textContent).toContain('Sound 0000');
    expect(list().scrollHeight).toBeGreaterThanOrEqual(5000 * ROW_H);
    expect(list().scrollHeight).toBeLessThan(5000 * ROW_H + 40);
    list().scrollTop = list().scrollHeight;
    await frames(3);
    expect(rows().length).toBeLessThan(80);
    expect(rows().at(-1)!.textContent).toContain('Sound 4999');
    list().scrollTop = 2500 * ROW_H;
    await frames(3);
    // The rows drawn sit where the spacer above them says: around the 2500th (the list is sorted by path).
    expect(Math.abs((rows()[0] as HTMLElement).offsetTop - 2500 * ROW_H)).toBeLessThanOrEqual(12 * ROW_H);
    list().scrollTop = 0;
    await frames(2);
    await expect.poll(() => footer(), EVENTUALLY).toContain('5,000 of 5,000 sounds');
  });

  it('scrolling and stepping make few DOM nodes and no work for rows out of view', async () => {
    await setRows(makeRows(5000));
    await frames(3);
    const before = host.querySelectorAll('*').length;
    for (let y = 0; y < 40; y++) {
      list().scrollTop = y * 800;
      await frames(1);
    }
    expect(Math.abs(host.querySelectorAll('*').length - before)).toBeLessThan(400);
  });

  it('the type chips, loops and search narrow the list; Clear filters brings it back', async () => {
    await setRows(makeRows(5000));
    await frames(3);
    click(chip('Kick'));
    await frames(3);
    // One of the 12 categories among the one-shots (1 in 11 are loops).
    const kicks = Number(/(\d[\d,]*) of 5,000 sounds/.exec(footer())![1]!.replace(',', ''));
    expect(kicks).toBeGreaterThan(300);
    expect(kicks).toBeLessThan(500);
    expect(rows().every((r) => r.textContent!.includes('Kick'))).toBe(true);
    click(chip('Clear filters'));
    await frames(3);
    await expect.poll(() => footer(), EVENTUALLY).toContain('5,000 of 5,000 sounds');
    click(chip('Loops'));
    await frames(3);
    await expect.poll(() => rows().every((r) => r.textContent!.includes('loop')), EVENTUALLY).toBe(true);
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'Sound 0330');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await frames(3);
    await expect.poll(() => rows().map((r) => r.textContent).join(' '), EVENTUALLY).toContain('Sound 0330');
    expect(rows().length).toBe(1);
    set.call(input, 'zzzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await frames(3);
    await expect.poll(() => host.textContent, EVENTUALLY).toContain(EMPTY_NO_MATCH_TEXT.slice(0, 30));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    click(chip('Clear filters'));
    await frames(3);
    expect(list()).toBeTruthy();
  });

  it('the tempo range and the key buttons filter loops and notes', async () => {
    await setRows(makeRows(1100));
    await frames(3);
    const lo = host.querySelector<HTMLInputElement>('input[aria-label="Lowest tempo in BPM"]')!;
    const hi = host.querySelector<HTMLInputElement>('input[aria-label="Highest tempo in BPM"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(lo, '100');
    lo.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(hi, '110');
    hi.dispatchEvent(new Event('input', { bubbles: true }));
    await frames(3);
    const shown = rows();
    expect(shown.length).toBeGreaterThan(0);
    for (const r of shown) {
      const bpm = Number(r.children[3]!.textContent);
      expect(bpm).toBeGreaterThanOrEqual(100);
      expect(bpm).toBeLessThanOrEqual(110);
    }
    click(chip('Clear filters'));
    await frames(3);
    // The fake notes: tonal sounds are on B, 808s on A♭.
    const bKey = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'B' && b.getAttribute('data-hint')?.startsWith('Sounds in B'))!;
    click(bKey);
    await frames(3);
    await expect.poll(() => rows().length, EVENTUALLY).toBeGreaterThan(0);
    expect(rows().every((r) => r.children[4]!.textContent === 'B')).toBe(true);
  });

  it('arrow keys step through the list and audition each sound; Escape stops', async () => {
    await setRows(makeRows(60), { selected: [], cursor: null });
    s.fakeEngine.previews.length = 0;
    await frames(3);
    list().focus();
    key(list(), 'ArrowDown');
    await frames(3);
    key(list(), 'ArrowDown');
    await frames(3);
    // Polled, not a fixed number of frames: under a loaded machine the audition can land a frame later.
    await expect.poll(() => s.fakeEngine.previews.length).toBe(2);
    expect(s.sampleBrowser.store.getState().cursor).toBe(rows()[1]!.dataset.sampleRow);
    expect(rows()[1]!.getAttribute('aria-selected')).toBe('true');
    key(list(), 'ArrowUp');
    await frames(3);
    await expect.poll(() => s.fakeEngine.previews.length).toBe(3);
    expect(s.sampleBrowser.store.getState().cursor).toBe(rows()[0]!.dataset.sampleRow);
    // Auto-play off: stepping only moves.
    s.sampleBrowser.setPrefs({ autoPreview: false });
    await frames(2);
    key(list(), 'ArrowDown');
    await frames(2);
    await expect.poll(() => s.fakeEngine.previews.length, EVENTUALLY).toBe(3);
    key(list(), 'Enter');
    await expect.poll(() => s.fakeEngine.previews.length).toBe(4);
    key(list(), 'Escape');
    await expect.poll(() => s.sampleBrowser.store.getState().playing).toBeNull();
    s.sampleBrowser.setPrefs({ autoPreview: true });
  });

  it('a click auditions, F and the star favorite, shift extends the selection', async () => {
    await setRows(makeRows(60), { selected: [], cursor: null });
    s.fakeEngine.previews.length = 0;
    await frames(3);
    click(rows()[2]!);
    // Polled, not a fixed number of frames: on a loaded machine the audition and the store can land a frame later.
    await expect.poll(() => s.fakeEngine.previews.length).toBe(1);
    key(list(), 'f');
    await expect.poll(() => s.sampleBrowser.rowById(rows()[2]!.dataset.sampleRow!)!.favorite).toBe(true);
    click(rows()[2]!.querySelector('button')!);
    await expect.poll(() => s.sampleBrowser.rowById(rows()[2]!.dataset.sampleRow!)!.favorite).toBe(false);
    click(rows()[5]!, { shiftKey: true });
    await expect.poll(() => s.sampleBrowser.store.getState().selected.length).toBe(4);
    // Only the favorites chip.
    click(rows()[3]!.querySelector('button')!);
    await frames(2);
    click(chip('★ Favorites'));
    await expect.poll(() => rows().length).toBe(1);
  });

  it('"Find similar sounds" lists the nearest, and the selection bar tags and makes a kit', async () => {
    const rowsIn = makeRows(40).map((r, i) => ({ ...r, analysis: { ...analysisOf(i), category: (['kick', 'snare', 'hat', 'clap'] as const)[i % 4]!, kind: 'one-shot' as const, vec: [i % 4, 0, 0, 0, 0, 0, 0, i % 4, 0, 0, 0, 0, 0] } }));
    await setRows(rowsIn, { selected: [], cursor: null });
    await frames(3);
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await frames(3);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')];
    const labels = items.map((b) => b.textContent);
    for (const l of ['Add as a sampler channel', 'Add to the playlist', 'Find similar sounds']) expect(labels.some((x) => x?.includes(l)), `${l} in ${labels.join(' | ')}`).toBe(true);
    expect(labels.some((x) => x === 'Play' || x === 'Stop')).toBe(true);
    expect(labels.some((x) => x?.includes('drum kit'))).toBe(true);
    items.find((b) => b.textContent?.includes('Find similar sounds'))!.click();
    await frames(3);
    await expect.poll(() => host.textContent, EVENTUALLY).toContain('Sounds like');
    expect(rows()[0]!.textContent).toContain('Kick');
    click(chip('Back to all sounds'));
    await frames(3);
    // Select four one-shots and make a kit.
    const one = (type: string) => rows().find((r) => r.children[2]!.textContent === type)!;
    click(one('Kick'));
    click(one('Snare'), { metaKey: true });
    click(one('Hat'), { metaKey: true });
    click(one('Clap'), { metaKey: true });
    await frames(3);
    const make = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Make a kit from'))!;
    expect(make.textContent).toBe('Make a kit from 4 one-shots');
    const before = s.doc.getState().project.channelOrder.length;
    click(make);
    await until(() => s.doc.getState().project.channelOrder.length > before);
    const kit = Object.values(s.doc.getState().project.channels).find((c) => c.kind === 'instrument' && c.plugin.pluginId === 'agstudio.drum-pads') as InstrumentChannel;
    expect(Object.keys(kit.plugin.samples ?? {}).sort()).toEqual(['pad1', 'pad3', 'pad4', 'pad7']);
    // Tags: type one and press Enter.
    const tagBox = host.querySelector<HTMLInputElement>('input[aria-label="Add a tag"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(tagBox, 'Punchy');
    tagBox.dispatchEvent(new Event('input', { bubbles: true }));
    await frames(2);
    key(tagBox, 'Enter');
    await frames(3);
    await expect.poll(() => s.sampleBrowser.store.getState().rows.filter((r) => r.userTags.includes('punchy')).length, EVENTUALLY).toBe(4);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'punchy')).toBe(true);
  });

  it('every control has a name and a hint, and the list says how to use it', async () => {
    await setRows(makeRows(300), { selected: [], cursor: null });
    await frames(3);
    click(rows()[0]!);
    await frames(3);
    const bad: string[] = [];
    for (const el of host.querySelectorAll<HTMLElement>('button, input, select, [role="option"], [role="listbox"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const name = el.getAttribute('aria-label') || el.textContent?.trim() || (el as HTMLInputElement).placeholder;
      const hint = el.closest('[data-hint]')?.getAttribute('data-hint');
      if (!name) bad.push(`no name: ${el.tagName} ${el.className}`);
      if (!hint && !el.getAttribute('aria-label')) bad.push(`no hint: ${el.tagName} "${name}"`);
      if (hint && hint.length < 12) bad.push(`vague hint: "${hint}"`);
    }
    expect(bad).toEqual([]);
    expect(list().getAttribute('data-hint')).toContain('arrow');
    expect(rows()[0]!.getAttribute('data-hint')).toContain('drag it onto');
  });
});

async function until(ok: () => boolean, ms = 30_000): Promise<void> {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
