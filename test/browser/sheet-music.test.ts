/**
 * The Sheet music window in the real UI (headless Chrome, React shell, test services with the fake engine): the pattern
 * drawn as SVG, notes selected by clicking and in step with the piano roll's selection, pitch and length edits through
 * History (one undo step each, the notes underneath change), note entry from the keyboard with what a screen reader hears,
 * the notes that play lighting up with no React commits, the print copy and its stylesheet, MusicXML out and back in, and
 * the accessibility checks (names, roles, structure) on the window with notes in it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { addInstrumentChannel } from '@app/actions/channels';
import { createTestServices } from '@app/testing';
import { importMusicXmlText, musicXmlOfSheet } from '@app/notation/actions';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { addNotes, removeNotes } from '@core/ops/notes';
import { notesSorted } from '@core/query/queries';
import { registerFeatures } from '@ui/features';
import { buildPrintPage } from '@ui/features/sheet-music/print';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { recentAnnouncements, resetAnnouncements } from '@ui/a11y/announce';
import { openWindow } from '@ui/workspace/registry';
import { ariaProblems, nameProblems, structureProblems, toggleStateProblems } from '../helpers/aria-audit';
import { EVENTUALLY, untilStill } from '../helpers/wait';
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
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe('sheet music (UI)', { timeout: 120_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let pattern: PatternId;
  let channel: ChannelId;
  let commits = 0;
  const windowEl = () => host.querySelector<HTMLElement>('[data-window-type="sheet-music"]');
  const page_ = () => windowEl()?.querySelector<HTMLElement>('[data-key-cursor]') ?? null;
  const heads = () => [...(windowEl()?.querySelectorAll<HTMLElement>('.ag-head') ?? [])];
  const selectedHeads = () => heads().filter((head) => head.classList.contains('ag-sel')).map((head) => head.dataset.note);
  const notes = (): Note[] => [...notesSorted(s.doc.getState().project.patterns[pattern]?.notes[channel])];
  const keys = () => notes().map((note) => note.key);
  const lastSaid = () => recentAnnouncements().at(-1);
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
    const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
    page_()!.dispatchEvent(event);
    return event;
  };
  const seed = (list: Pick<Note, 'tick' | 'key' | 'length'>[]): Note[] => {
    const made = list.map((note) => ({ id: newId.note(), velocity: 0.8, ...note }));
    s.history.transact('seed', (d) => addNotes(d, pattern, channel, made));
    return made;
  };
  const focusPage = async () => {
    page_()!.blur();
    page_()!.focus();
    await expect.poll(() => page_()!.matches(':focus-visible'), EVENTUALLY).toBe(true);
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    s = createTestServices();
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    const project = s.doc.getState().project;
    pattern = project.patternOrder[0] as PatternId;
    void project;
    // The empty project's first channels are drum samplers; the sheet tests need a pitched instrument.
    channel = addInstrumentChannel(s, 'agstudio.3xosc') as ChannelId;
    s.view.getState().setCurrentPattern(pattern);
    s.session.getState().selectChannel(channel);
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'sheet-music');
    s.view.getState().setMaximized('sheet-music', true);
    root = createRoot(host);
    root.render(createElement(Profiler, { id: 'app', onRender: () => commits++ }, createElement(ServicesProvider, { services: s, children: createElement(App) })));
    await until(() => !!page_());
    await frames(3);
  });

  beforeEach(async () => {
    page_()?.blur();
    const ids = notes().map((note) => note.id);
    if (ids.length) s.history.transact('clear', (d) => removeNotes(d, pattern, channel, ids));
    s.editor.getState().selectNotes([]);
    s.editor.getState().setSheet({ entry: { base: 4, isDotted: false, isTriplet: false }, follow: true, part: 'auto' });
    resetAnnouncements();
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('says what to do while the pattern has no notes, then draws them as soon as there are some', async () => {
    expect(windowEl()!.textContent).toContain('No notes to show yet');
    expect(heads()).toHaveLength(0);
    seed([
      { tick: 0, key: 72, length: 960 },
      { tick: 960, key: 74, length: 960 },
    ]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(2);
    expect(windowEl()!.textContent).not.toContain('No notes to show yet');
    expect(windowEl()!.querySelectorAll('svg.ag-system').length).toBeGreaterThan(0);
  });

  it('click a note to select it, in step with the piano roll selection; click empty space to clear', async () => {
    const made = seed([
      { tick: 0, key: 72, length: 960 },
      { tick: 960, key: 74, length: 960 },
    ]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(2);
    const first = heads().find((head) => head.dataset.note === made[0]!.id)!;
    const box = first.getBoundingClientRect();
    first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: box.x + 4, clientY: box.y + 4 }));
    expect(s.editor.getState().noteSelection).toEqual([made[0]!.id]);
    await expect.poll(selectedHeads, EVENTUALLY).toEqual([made[0]!.id]);
    // The other direction: the selection the piano roll makes shows here.
    s.editor.getState().selectNotes([made[1]!.id]);
    await expect.poll(selectedHeads, EVENTUALLY).toEqual([made[1]!.id]);
    const svg = windowEl()!.querySelector('svg.ag-system')!.getBoundingClientRect();
    windowEl()!.querySelector('svg.ag-system')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: svg.right - 5, clientY: svg.bottom - 5 }));
    await expect.poll(selectedHeads, EVENTUALLY).toEqual([]);
  });

  it('Up and Down move the selected notes a scale step as one undo step that changes the piano roll too', async () => {
    const made = seed([{ tick: 0, key: 72, length: 960 }]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(1);
    s.editor.getState().selectNotes([made[0]!.id]);
    await focusPage();
    const steps = s.history.steps().done.length;
    expect(press('ArrowUp').defaultPrevented).toBe(true);
    expect(press('ArrowUp').defaultPrevented).toBe(true);
    expect(keys()).toEqual([76]);
    press('ArrowDown', { shiftKey: true });
    expect(keys()).toEqual([75]);
    press('ArrowUp', { ctrlKey: true });
    expect(keys()).toEqual([87]);
    await expect.poll(lastSaid, EVENTUALLY).toContain('Moved 1 note up a octave');
    // Moves made one after another merge into one undo step, as the piano roll's nudges do.
    expect(s.history.steps().done.length).toBe(steps + 1);
    s.history.undo();
    expect(keys()).toEqual([72]);
  });

  it('number keys change the length of the selected notes, Delete removes them', async () => {
    const made = seed([{ tick: 0, key: 72, length: 960 }]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(1);
    s.editor.getState().selectNotes([made[0]!.id]);
    await focusPage();
    press('8');
    expect(notes()[0]!.length).toBe(480);
    press('.');
    press('4');
    expect(notes()[0]!.length).toBe(1440);
    press('Delete');
    expect(notes()).toHaveLength(0);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Deleted 1 note');
    s.history.undo();
    expect(notes()).toHaveLength(1);
  });

  it('typing note letters puts notes at the cursor, one undo step each, and says what it did', async () => {
    seed([{ tick: 0, key: 72, length: 240 }]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(1);
    await focusPage();
    press('End');
    const steps = s.history.steps().done.length;
    press('e');
    press('f');
    press('g', { shiftKey: true });
    // The cursor starts on the last note (End), and each typed note moves it on by the entry duration (a quarter note).
    expect(notes().map((note) => [note.tick, note.key, note.length])).toEqual([
      [0, 72, 240],
      [0, 76, 960],
      [960, 77, 960],
      [1920, 80, 960],
    ]);
    expect(s.history.steps().done.length).toBe(steps + 3);
    expect(s.editor.getState().noteSelection).toEqual([notes()[3]!.id]);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Added G sharp 5, quarter note, bar 1, beat 3');
    s.history.undo();
    expect(notes()).toHaveLength(3);
    // Left moves back through the notes and names the note it lands on.
    press('ArrowLeft');
    await expect.poll(lastSaid, EVENTUALLY).toBe('bar 1, beat 2, F 5, quarter note');
  });

  it('question mark says where the cursor is, what is selected and the entry duration', async () => {
    const made = seed([{ tick: 960, key: 72, length: 960 }]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(1);
    s.editor.getState().selectNotes([made[0]!.id]);
    await focusPage();
    press('?');
    await expect.poll(lastSaid, EVENTUALLY).toContain('1 note selected. Entry duration: quarter note.');
  });

  it('lights the notes that play and follows with no React commits', async () => {
    seed([
      { tick: 0, key: 72, length: 960 },
      { tick: 960, key: 74, length: 960 },
      { tick: 1920, key: 76, length: 960 },
    ]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(3);
    const lit = () => [...windowEl()!.querySelectorAll<HTMLElement>('.ag-chord.ag-now')].map((el) => el.dataset.t0);
    s.view.getState().setMode('pattern');
    s.fakeEngine.startTick = 10;
    s.engine.play();
    await expect.poll(lit, EVENTUALLY).toEqual(['0']);
    await untilStill(() => commits);
    const before = commits;
    s.fakeEngine.startTick = 1000;
    await expect.poll(lit, EVENTUALLY).toEqual(['960']);
    s.fakeEngine.startTick = 2000;
    await expect.poll(lit, EVENTUALLY).toEqual(['1920']);
    await frames(10);
    expect(commits).toBe(before);
    s.engine.stop();
    await expect.poll(lit, EVENTUALLY).toEqual([]);
  });

  it('builds a print copy (black on white, systems kept whole) and has a print stylesheet that hides the app', async () => {
    seed([{ tick: 0, key: 72, length: 960 }]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(1);
    const copy = buildPrintPage(s)!;
    expect(copy.id).toBe('ag-print-root');
    expect(copy.querySelectorAll('svg.ag-system').length).toBeGreaterThan(0);
    expect(copy.querySelector('h1')!.textContent).toBeTruthy();
    const printRules: string[] = [];
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSMediaRule && rule.media.mediaText.includes('print')) printRules.push(rule.cssText);
      }
    }
    expect(printRules.join('\n')).toContain('#ag-print-root');
    expect(printRules.join('\n')).toContain('break-inside: avoid');
    expect(printRules.join('\n')).toMatch(/display:\s*none\s*!important/);
  });

  it('exports MusicXML of the part and imports it into another channel as one undo step', async () => {
    seed([
      { tick: 0, key: 72, length: 960 },
      { tick: 960, key: 74, length: 960 },
    ]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(2);
    const file = musicXmlOfSheet(s)!;
    expect(file.name.endsWith('.musicxml')).toBe(true);
    expect(file.xml).toContain('<score-partwise version="4.0">');
    s.history.transact('clear', (d) => removeNotes(d, pattern, channel, notes().map((note) => note.id)));
    const steps = s.history.steps().done.length;
    const result = importMusicXmlText(s, file.xml, { replace: true });
    expect(result.ok).toBe(true);
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect(notes().map((note) => [note.tick, note.length, note.key])).toEqual([
      [0, 960, 72],
      [960, 960, 74],
    ]);
    expect(importMusicXmlText(s, '<html/>', { replace: true })).toMatchObject({ ok: false });
  });

  it('passes the accessibility checks with notes in the window', async () => {
    seed([
      { tick: 0, key: 72, length: 960 },
      { tick: 960, key: 74, length: 960 },
    ]);
    await expect.poll(() => heads().length, EVENTUALLY).toBe(2);
    const region = windowEl()!;
    const problems = [...nameProblems(region), ...ariaProblems(region), ...structureProblems(region), ...toggleStateProblems(region)];
    expect(problems).toEqual([]);
    const stop = page_()!;
    expect(stop.getAttribute('role')).toBe('application');
    expect(stop.getAttribute('aria-label')).toBe('Sheet music');
    expect(stop.tabIndex).toBe(0);
    expect(stop.querySelector('.ag-sheet-text')!.textContent).toContain('Bar 1: beat 1 C 5 quarter note');
    expect([...stop.querySelectorAll('svg')].every((svg) => svg.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});
