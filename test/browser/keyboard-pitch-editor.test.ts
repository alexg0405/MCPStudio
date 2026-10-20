/**
 * The Pitch editor's keyboard cursor (headless Chrome, the real React shell, test services with the fake engine): Tab puts
 * the editor in reach with a name and a description, Left and Right go from note to note and say which one it is, notes
 * are selected, retuned (a held key is one undo step), put back as sung, split and joined from the keyboard, and the cursor
 * is drawn only while the keyboard has the editor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestServices } from '@app/testing';
import { loadPitchClip } from '@app/actions/pitch';
import { pitchState } from '@app/pitch/state';
import type { AudioClip, ClipId } from '@core/model/types';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { ServicesProvider } from '@ui/services-context';
import { App } from '@ui/shell/App';
import { recentAnnouncements, resetAnnouncements } from '@ui/a11y/announce';
import { openWindow } from '@ui/workspace/registry';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { sing } from '../helpers/sung';
import { EVENTUALLY } from '../helpers/wait';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const SR = 48000;
const until = async (ok: () => boolean, ms = 60_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

const CODES: Record<string, string> = { a: 'KeyA', s: 'KeyS', m: 'KeyM', '?': 'Slash' };

describe('pitch editor keyboard cursor (UI)', { timeout: 120_000 }, () => {
  let s: ReturnType<typeof createTestServices>;
  let root: Root;
  let host: HTMLDivElement;
  let clipId: ClipId;
  let area: HTMLElement;
  let overlay: HTMLCanvasElement;
  const clip = () => s.doc.getState().project.playlist.clips[clipId] as AudioClip;
  const shifts = () => (clip().pitchEdit?.notes ?? []).map((n) => n.shift ?? 0);
  /** The notes the editor shows: the edit's (after a split or join), else the ones found in the recording. */
  const noteCount = () => clip().pitchEdit?.notes.length ?? pitchState.getState().clip?.analysis.notes.length ?? 0;
  const cursor = () => s.history.status().cursor;
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, code: CODES[key] ?? key, bubbles: true, cancelable: true, ...init });
    area.dispatchEvent(event);
    return event;
  };
  const lastSaid = () => recentAnnouncements().at(-1);
  const summary = () => area.querySelector<HTMLElement>('[id^="ag-key-summary"]')?.textContent ?? '';
  /** Tab arrives on the editor with the cursor on the first note. */
  const focusEditor = async () => {
    area.blur();
    area.focus();
    await expect.poll(() => area.matches(':focus-visible'), EVENTUALLY).toBe(true);
    press('Home');
    await expect.poll(summary, EVENTUALLY).toContain('Cursor on note 1');
    resetAnnouncements();
  };
  const paintedPixels = (): number => {
    const data = overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) count++;
    return count;
  };

  beforeAll(async () => {
    await page.viewport(1280, 800);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1280px;height:800px';
    document.body.append(host);
    const voice = sing(
      [
        { from: 0.1, to: 0.8, midi: 60.3 },
        { from: 1.0, to: 1.8, midi: 64 - 0.35 },
      ],
      SR,
      2.2,
    );
    const samples = new TestSamples();
    const ref = samples.add([voice], SR, 'vocal');
    const made = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
    s = createTestServices();
    s.fakeEngine.sampleAudio.set('vocal', { sampleRate: SR, channels: [voice], duration: voice.length / SR });
    s.history.load(made.project);
    clipId = made.clipIds[0] as ClipId;
    s.assistant.set({ backend: 'offline', autoplay: false });
    s.prefs.getState().set({ welcomeSeen: true });
    registerFeatures(s);
    installKeyboard(s);
    openWindow(s, 'pitch-editor');
    s.view.getState().setMaximized('pitch-editor', true);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(App) }));
    await until(() => !!host.querySelector('[data-window-type="pitch-editor"] [class*="stage"]'));
    area = host.querySelector<HTMLElement>('[data-window-type="pitch-editor"] [class*="area"]')!;
    overlay = area.querySelectorAll('canvas')[4] as HTMLCanvasElement;
    await loadPitchClip(s, clipId);
    await until(() => noteCount() === 2);
    await frames(3);
  });

  beforeEach(async () => {
    area.blur();
    while (s.history.status().canUndo) await s.history.undo();
    await until(() => noteCount() === 2);
    pitchState.setState({ selected: [] });
    resetAnnouncements();
    await frames(2);
  });

  afterAll(() => {
    root.unmount();
    host.remove();
  });

  it('is one Tab stop with a name and a description of the notes and where the cursor is', async () => {
    expect(area.tabIndex).toBe(0);
    expect(area.getAttribute('role')).toBe('application');
    expect(area.getAttribute('aria-label')).toBe('Pitch editor notes');
    expect(area.getAttribute('aria-describedby')).toBe(area.querySelector('[id^="ag-key-summary"]')!.id);
    await focusEditor();
    expect(summary()).toContain('2 notes, 0 selected.');
    expect(summary()).toContain('Cursor on note 1: C5');
  });

  it('Left and Right go from note to note and say which one, how high, when and how long', async () => {
    await focusEditor();
    press('ArrowRight');
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Note 2 of 2, E5 minus \d+ cents, at 1\.\d seconds, 0\.[6-9] seconds long$/);
    press('ArrowRight');
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Note 2 of 2,/);
    press('ArrowLeft');
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Note 1 of 2, C5 plus \d+ cents, at 0\.\d seconds/);
    press('End');
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Note 2 of 2/);
    press('Home');
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Note 1 of 2/);
  });

  it('Enter selects the note under the cursor, Enter again deselects it, Shift with the arrows selects a run', async () => {
    await focusEditor();
    press('Enter');
    await expect.poll(() => pitchState.getState().selected, EVENTUALLY).toEqual([0]);
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/, selected$/);
    press('Enter');
    await expect.poll(() => pitchState.getState().selected, EVENTUALLY).toEqual([]);
    press('ArrowRight', { shiftKey: true });
    await expect.poll(() => pitchState.getState().selected, EVENTUALLY).toEqual([0, 1]);
    await expect.poll(lastSaid, EVENTUALLY).toContain('2 notes selected');
  });

  it('Up and Down retune the selected note a semitone, Ctrl an octave, Alt a cent; a held key is one undo step', async () => {
    await focusEditor();
    press('Enter');
    await expect.poll(() => pitchState.getState().selected, EVENTUALLY).toEqual([0]);
    const before = cursor();
    press('ArrowUp');
    await expect.poll(() => shifts()[0], EVENTUALLY).toBe(100);
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Retuned 1 note\. Note 1 of 2, C sharp 5/);
    for (let i = 0; i < 3; i++) press('ArrowUp', { repeat: true });
    await expect.poll(() => shifts()[0], EVENTUALLY).toBe(400);
    expect(s.history.status().undoLabel).toBe('Move note');
    await s.history.undo();
    expect(shifts()[0] ?? 0).toBe(0);
    expect(cursor()).toBe(before);
    press('ArrowDown', { ctrlKey: true });
    await expect.poll(() => shifts()[0], EVENTUALLY).toBe(-1200);
    press('ArrowUp', { altKey: true });
    await expect.poll(() => shifts()[0], EVENTUALLY).toBe(-1199);
  });

  it('Up with nothing selected retunes the note under the cursor', async () => {
    await focusEditor();
    press('ArrowRight');
    press('ArrowUp');
    await expect.poll(() => shifts()[1], EVENTUALLY).toBe(100);
    expect(pitchState.getState().selected).toEqual([1]);
    await s.history.undo();
  });

  it('Delete puts the selected notes back as sung', async () => {
    await focusEditor();
    press('Enter');
    press('ArrowUp');
    await expect.poll(() => shifts()[0], EVENTUALLY).toBe(100);
    press('Delete');
    await expect.poll(() => shifts()[0] ?? 0, EVENTUALLY).toBe(0);
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Put 1 note back as sung\./);
  });

  it('S splits the note under the cursor in two and M joins it with the next', async () => {
    await focusEditor();
    press('s');
    await expect.poll(noteCount, EVENTUALLY).toBe(3);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Split into two notes. 3 notes now');
    press('m');
    await expect.poll(noteCount, EVENTUALLY).toBe(2);
    await expect.poll(lastSaid, EVENTUALLY).toMatch(/^Joined with the next note\./);
  });

  it('Ctrl+A selects every note, Escape clears the selection, and Escape with none selected says nothing', async () => {
    await focusEditor();
    press('a', { ctrlKey: true });
    await expect.poll(() => pitchState.getState().selected, EVENTUALLY).toEqual([0, 1]);
    press('Escape');
    await expect.poll(() => pitchState.getState().selected, EVENTUALLY).toEqual([]);
    await expect.poll(lastSaid, EVENTUALLY).toBe('Selection cleared');
    const said = recentAnnouncements().length;
    press('Escape');
    await frames(3);
    expect(recentAnnouncements()).toHaveLength(said);
  });

  it('the question mark describes the cursor and the keys at once; Insert explains that notes cannot be added', async () => {
    await focusEditor();
    press('?', { shiftKey: true });
    await expect.poll(lastSaid, EVENTUALLY).toContain('Pitch editor for');
    expect(lastSaid()).toContain('Under the cursor: Note 1 of 2');
    press('Insert');
    await expect.poll(lastSaid, EVENTUALLY).toContain('none can be added');
  });

  it('draws the cursor only while the keyboard has the editor', async () => {
    await frames(3);
    const idle = paintedPixels();
    await focusEditor();
    await expect.poll(paintedPixels, EVENTUALLY).toBeGreaterThan(idle);
    area.blur();
    await expect.poll(paintedPixels, EVENTUALLY).toBe(idle);
  });

  it('leaves the arrow keys to the editor’s own handling when it does not have keyboard focus (mouse users keep retuning a clicked note)', async () => {
    pitchState.setState({ selected: [0] });
    (document.activeElement as HTMLElement | null)?.blur();
    press('ArrowUp');
    await expect.poll(() => shifts()[0], EVENTUALLY).toBe(100);
    expect(recentAnnouncements()).toHaveLength(0);
    await s.history.undo();
  });
});
