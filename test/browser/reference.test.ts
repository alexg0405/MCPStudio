/**
 * Reference track matching through the real engine: a synthetic reference with a known structure (a 16-bar
 * intro, a 32-bar drop, a 16-bar break and a 32-bar drop at 128 BPM, scaled to −8 LUFS) is written as a WAV,
 * stored like any imported file, analyzed (tempo, key, sections, loudness, tonal balance per section) and set
 * as the reference of a house song at another tempo. Matching it gives the project the reference's tempo and
 * section lengths and levels the mix to within 0.5 dB of −8 LUFS, as one undo step. (The same through a Studio answer is
 * `reference-studio.test.ts`; the reference song is made in `test/helpers/reference-song.ts`.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { arrangeLikeReference, matchLoudness, matchTempoAndKey, setReferenceFromFile } from '@app/reference/actions';
import { referenceState } from '@app/reference/state';
import { toneDifference } from '@app/reference/actions';
import { createServices, type Services } from '@app/services';
import { songSections } from '@core/query/sections';
import { TONE_BANDS } from '@core/reference/bands';
import { loudnessTarget } from '@core/reference/track';
import { registerFeatures } from '@ui/features';
import { ServicesProvider } from '@ui/services-context';
import { openWindow } from '@ui/workspace/registry';
import { ReferenceWindow } from '@ui/features/reference/ReferenceWindow';
import { buildSong } from '../helpers/mix-level';
import { BAR, loudnessOfBusiestPart, referenceFile, TARGET } from '../helpers/reference-song';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const services: Services[] = [];
afterAll(async () => {
  for (const s of services) await s.engine.dispose();
});

describe('reference track matching (headless Chrome, real analysis and renders)', () => {
  const file = referenceFile();
  let s!: Services;

  beforeAll(async () => {
    s = createServices();
    services.push(s);
    // A house song at 124 BPM with its mix set up (buses and a master Limiter).
    const res = buildSong(s, 'house', { bpm: 124, low: 'bass' });
    expect(res.warnings).toEqual([]);
  }, 120_000);

  it('analyzes the reference file: tempo, key, the four parts, loudness, tonal balance per part', async () => {
    const before = s.doc.getState().project;
    const t0 = performance.now();
    const track = await setReferenceFromFile(s, file);
    const ms = Math.round(performance.now() - t0);
    expect(track).not.toBeNull();
    const ref = s.doc.getState().project.reference!;
    console.log(
      `reference analysis: ${ms} ms; ${ref.bpm} BPM, key ${ref.key?.camelot}, ${ref.lufs} LUFS, true peak ${ref.truePeakDb} dBTP, width ${ref.width}; ` +
        ref.sections.map((x) => `${x.kind} ${x.bars} bars (energy ${x.energy})`).join(' · '),
    );
    expect(Math.abs(ref.bpm! - 128)).toBeLessThanOrEqual(0.05);
    expect(ref.key).toMatchObject({ root: 9, mode: 'minor' });
    expect(Math.abs(ref.lufs - TARGET)).toBeLessThanOrEqual(0.6);
    expect(ref.sections.map((x) => [x.kind, x.bars])).toEqual([
      ['intro', 16],
      ['drop', 32],
      ['break', 16],
      ['drop', 32],
    ]);
    // The drops are the loudest parts; the break is quieter than the drops.
    expect(ref.sections[1]!.energy).toBeGreaterThan(ref.sections[0]!.energy);
    expect(ref.sections[2]!.energy).toBeLessThan(ref.sections[1]!.energy - 0.3);
    // Tonal balance: eight bands per section; the break (pads only) has less low end than the drop (kick, bass).
    expect(ref.bands).toHaveLength(TONE_BANDS.length);
    for (const x of ref.sections) expect(x.bands).toHaveLength(TONE_BANDS.length);
    const low = (b: number[]) => Math.max(b[0]!, b[1]!);
    expect(low(ref.sections[1]!.bands)).toBeGreaterThan(low(ref.sections[2]!.bands) + 3);
    expect(ref.width).toBeCloseTo(0, 2);
    // The file is a sample of the project, kept out of the song: no channel or clip plays it.
    const p = s.doc.getState().project;
    expect(p.samples[ref.sampleId!]?.source.kind).toBe('embedded');
    expect(Object.values(p.channels).some((c) => c.kind === 'audioClip' && c.sampleId === ref.sampleId)).toBe(false);
    // One undo step.
    expect(s.history.steps().done.at(-1)?.label).toMatch(/^Set the reference/);
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    s.history.redo();
  }, 240_000);

  it('Match tempo and key, Arrange like the reference, Match loudness: each one undo step; the project follows the reference', async () => {
    const start = s.doc.getState().project;
    expect(start.reference).toBeDefined();
    expect(start.transport.bpm).toBe(124);

    const tempo = matchTempoAndKey(s);
    expect(tempo.error).toBeUndefined();
    expect(s.doc.getState().project.transport.bpm).toBe(128);
    expect(s.doc.getState().project.transport.key).toEqual({ root: 9, scale: 'minor' });

    const arranged = arrangeLikeReference(s);
    expect(arranged.error).toBeUndefined();
    const after = s.doc.getState().project;
    const sections = songSections(after);
    const bars = sections.map((x) => (x.to - x.from) / BAR);
    expect(sections.map((x) => x.from / BAR + 1)).toEqual([1, 17, 49, 65]);
    // The last section's stop effects ring a little past bar 96.
    expect(bars.slice(0, 3)).toEqual([16, 32, 16]);
    expect(bars[3]).toBeGreaterThanOrEqual(32);
    expect(bars[3]).toBeLessThanOrEqual(33);
    expect(after.transport.bpm).toBe(128);

    // The song is not the reference: only the musician's own patterns play.
    const names = new Set(Object.values(start.patterns).map((x) => x.name));
    for (const c of Object.values(after.playlist.clips))
      if (c.kind === 'pattern') expect([...names].some((n) => after.patterns[c.patternId]!.name.startsWith(n))).toBe(true);

    const before = s.doc.getState().project;
    const steps = s.history.steps().done.length;
    const t0 = performance.now();
    const level = await matchLoudness(s);
    expect(level).not.toBeNull();
    const heard = await loudnessOfBusiestPart(s);
    console.log(
      `match loudness: ${Math.round(performance.now() - t0)} ms; master ${heard.lufs.toFixed(2)} LUFS (target ${TARGET}), true peak ${heard.truePeakDb!.toFixed(2)} dBTP over bars ${heard.window.fromTick / BAR + 1}–${heard.window.fromTick / BAR + heard.window.bars}; ${level!.changes.join(' · ')}`,
    );
    // The reference file measures about −8.4 LUFS (scaled to −8 in the file's own sample rate and gating): that is the target.
    const goal = loudnessTarget(s.doc.getState().project.reference!);
    expect(Math.abs(goal - TARGET)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(heard.lufs - goal)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(level!.master.lufs - goal)).toBeLessThanOrEqual(0.5);
    expect(heard.truePeakDb!).toBeLessThanOrEqual(-0.95);
    expect(s.history.steps().done.length).toBe(steps + 1);
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    s.history.redo();
  }, 600_000);

  it('Show the tonal difference measures the mix in the same bands and compares it with the reference', async () => {
    const report = await toneDifference(s);
    expect(report).not.toBeNull();
    console.log(`tonal difference over ${report!.song.what}: ${report!.lines.join(' | ')}`);
    expect(report!.song.bands).toHaveLength(TONE_BANDS.length);
    expect(report!.comparison.bands).toHaveLength(TONE_BANDS.length);
    expect(report!.lines.length).toBeGreaterThan(0);
    expect(referenceState.getState().tone).toBe(report);
    // It changes nothing.
    const p = s.doc.getState().project;
    await toneDifference(s);
    expect(s.doc.getState().project).toBe(p);
  }, 240_000);

});

describe('the Reference window', () => {
  let host: HTMLElement;
  let root: Root;
  let s!: Services;

  beforeAll(async () => {
    s = createServices();
    services.push(s);
    registerFeatures(s);
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:700px;height:700px';
    document.body.append(host);
    root = createRoot(host);
  });
  afterAll(() => root.unmount());

  const mount = async () => {
    root.render(createElement(ServicesProvider, { services: s, children: createElement(ReferenceWindow) }));
    await new Promise((r) => setTimeout(r, 100));
  };

  it('says what to do when there is no reference', async () => {
    await mount();
    expect(host.innerText).toMatch(/Drop a song you own here, or choose a file/);
    expect(host.innerText).toMatch(/never copied, played or put in your song/);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Choose a song file…', 'From my music…']);
  });

  it('shows the reference next to the song, with the four actions, every control explained', async () => {
    const { fakeReference } = await import('@core/reference/fixtures');
    s.history.transact('ref', (d) => void (d.reference = fakeReference({ title: 'Nova – Known' }) as never));
    await mount();
    const text = host.innerText.replace(/\s+/g, ' ');
    expect(text).toContain('Nova – Known');
    expect(text).toMatch(/Tempo 128 BPM 130 BPM \(\+2\)/);
    expect(text).toMatch(/Intro 16/);
    expect(text).toMatch(/Drop 32/);
    for (const label of ['Match tempo and key', 'Arrange like the reference', 'Match loudness', 'Show the tonal difference']) expect(text).toContain(label);
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(7);
    for (const b of buttons) expect(b.closest('[data-hint]')?.getAttribute('data-hint') ?? b.getAttribute('aria-label'), b.textContent ?? '').toBeTruthy();
    expect(text).not.toMatch(/\bAI\b/);
    // The tonal-balance chart has a row per band.
    expect(host.querySelectorAll('[data-hint*="the reference has"]').length).toBe(TONE_BANDS.length);
  });

  it('opens from the View menu command and the action search', () => {
    expect(s.commands.get('reference.open')?.title).toBe('Reference');
    const id = openWindow(s, 'reference');
    expect(s.view.getState().windows[id]?.visible).toBe(true);
  });
});
