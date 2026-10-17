/**
 * Reference track matching through the real engine: a synthetic reference with a known structure (a 16-bar
 * intro, a 32-bar drop, a 16-bar break and a 32-bar drop at 128 BPM, scaled to −8 LUFS) is written as a WAV,
 * stored like any imported file, analyzed (tempo, key, sections, loudness, tonal balance per section) and set
 * as the reference of a house song at another tempo. Matching it gives the project the reference's tempo and
 * section lengths and levels the mix to within 1.5 dB of −8 LUFS, as one undo step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyAnswer } from '@app/ai/apply';
import { Measurer } from '@app/analysis/measure';
import { afterStepFor } from '@app/assistant/after-steps';
import { busiestWindow } from '@app/mix/auto-level';
import { arrangeLikeReference, matchLoudness, matchTempoAndKey, setReferenceFromFile } from '@app/reference/actions';
import { forgetReferences } from '@app/reference/analyze';
import { referenceState } from '@app/reference/state';
import { toneDifference } from '@app/reference/actions';
import { createServices, type Services } from '@app/services';
import { renderTestSong, PATTERNS, MINOR, chord } from '@core/dj/test-songs';
import { encodeWav } from '@core/io/wav';
import { songSections } from '@core/query/sections';
import { TONE_BANDS } from '@core/reference/bands';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { tempoMapOf } from '@core/automation/tempo';
import { registerFeatures } from '@ui/features';
import { ServicesProvider } from '@ui/services-context';
import { openWindow } from '@ui/workspace/registry';
import { ReferenceWindow } from '@ui/features/reference/ReferenceWindow';
import { buildSong } from '../helpers/mix-level';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const RATE = 44100;
const TARGET = -8;
const BAR = 3840;

/** The reference as a WAV file: the structure above, scaled so its integrated loudness is −8 LUFS. */
function referenceFile() {
  const all = { kick: true, snare: true, hats: true, bass: true, pads: true };
  const song = renderTestSong({
    sampleRate: RATE,
    bpm: 128,
    pattern: PATTERNS.house,
    offset: 0.2,
    tail: 0.2,
    chords: [chord(57, MINOR), chord(50, MINOR), chord(52, [0, 4, 7]), chord(57, MINOR)],
    parts: [
      { bars: 16, kick: true, hats: true, level: 0.7 },
      { bars: 32, ...all, crash: true },
      { bars: 16, pads: true, level: 0.6 },
      { bars: 32, ...all, crash: true },
    ],
  });
  const m = new Measurer(RATE);
  m.push(song.mono, song.mono);
  const gain = Math.pow(10, (TARGET - m.result().lufs) / 20);
  const scaled = song.mono.map((v) => v * gain);
  const wav = encodeWav([scaled, scaled], RATE, { bitDepth: 32 });
  return { name: 'Reference – Drops.wav', arrayBuffer: async () => wav.slice().buffer, scaledPeak: 0.9 * gain, partStarts: song.partStarts };
}

/** The busiest part of the song rendered again, as heard (master chain, Limiter), measured on its own. */
async function loudnessOfBusiestPart(s: Services) {
  const p = s.doc.getState().project;
  const w = busiestWindow(p, null)!;
  const tempo = tempoMapOf(p, w.mode);
  const toTick = w.fromTick + w.bars * ticksPerBar(p.transport.timeSig);
  const rate = 48000;
  const frames = Math.round((tempo.tickToSeconds(toTick) - tempo.tickToSeconds(w.fromTick)) * rate);
  const r = await renderOffline(p, {
    plugins: s.plugins,
    view: { mode: w.mode, patternId: w.patternId, loop: null },
    bars: w.bars,
    fromTick: w.fromTick,
    sampleRate: rate,
    tail: 0,
    limiter: true,
  });
  const start = Math.round((r.preRoll + r.latency) * rate);
  const m = new Measurer(rate, true);
  m.push(r.buffer.getChannelData(0).subarray(start, start + frames), r.buffer.getChannelData(1).subarray(start, start + frames));
  return { ...m.result(), window: w };
}

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
    expect(Math.abs(heard.lufs - TARGET)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(level!.master.lufs - TARGET)).toBeLessThanOrEqual(1.5);
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

  it('Studio: set_reference and match_reference in one answer: analyzed after it, matched, leveled, one undo step', async () => {
    const s2 = createServices();
    services.push(s2);
    buildSong(s2, 'house', { bpm: 124, low: 'bass' });
    const before = s2.doc.getState().project;
    // The file is stored like any other (the music library does this).
    const { songFromBytes, library } = await import('@app/dj/library');
    const song = await songFromBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    library.setState({ songs: [song!], selected: [] });
    forgetReferences();
    const res = applyAnswer(
      s2,
      { message: 'Like your reference', actions: [{ op: 'set_reference', song: 'Reference' }, { op: 'match_reference' }] },
      { previousBeat: null, label: 'like my reference' },
    );
    expect(res.warnings).toEqual([]);
    expect(res.after.map((a) => a.kind)).toEqual(['set_reference', 'match_reference']);
    let entry: number | null = res.edited ? s2.history.status().cursor : null;
    const progress: string[] = [];
    const messages: string[] = [];
    for (const item of res.after) {
      const step = afterStepFor(item.kind)!;
      const was = s2.history.status().cursor;
      const out = await step(item, {
        s: s2,
        entry,
        signal: new AbortController().signal,
        progress: (label) => progress.push(label),
        whenQuiet: async () => {},
      });
      if (entry === null && s2.history.status().cursor !== was) entry = s2.history.status().cursor;
      messages.push(...[out?.message ?? '', ...(out?.changes ?? [])]);
    }
    library.setState({ songs: [], selected: [] });
    const p = s2.doc.getState().project;
    console.log(`Studio match:\n  ${messages.join('\n  ')}`);
    expect(p.reference?.title).toBe(song!.label);
    expect(p.transport.bpm).toBe(128);
    expect(songSections(p).map((x) => x.from / BAR + 1)).toEqual([1, 17, 49, 65]);
    const heard = await loudnessOfBusiestPart(s2);
    console.log(`Studio match loudness: ${heard.lufs.toFixed(2)} LUFS, true peak ${heard.truePeakDb!.toFixed(2)} dBTP`);
    expect(Math.abs(heard.lufs - TARGET)).toBeLessThanOrEqual(1.5);
    expect(progress).toContain('The mix');
    // Setting the reference, matching it and leveling are one undo step.
    expect(s2.history.steps().done.filter((e) => /like my reference|Set the reference|Match the reference|Level the mix/.test(e.label)).length).toBe(1);
    s2.history.undo();
    expect(s2.doc.getState().project).toEqual(before);
  }, 600_000);
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
