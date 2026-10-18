/**
 * DJ track analysis on real AGstudio audio: the project templates rendered offline (the engine's
 * own instruments, effects and mix), analyzed for tempo, key and downbeat; and the analyzer's Worker
 * path, from WAV bytes decoded by the browser to a cached result.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@app/services';
import { templateProject, TEMPLATES } from '@app/templates';
import { runAnalysis } from '@app/dj/analysis-run';
import { createTrackAnalyzer, memoryAnalysisStorage } from '@app/dj/analysis-cache';
import { opfsSampleProvider } from '@app/persistence/project-io';
import { camelotOf, keyName } from '@core/dj/key';
import { encodeWav } from '@core/io/wav';
import type { SampleId, SampleRef } from '@core/model/types';
import { decodeAudio } from '@engine/decode';
import { renderOffline } from '@engine/render-offline';

const RATE = 44100;
/** The key each template's beat is written in when the prompt names none (core/beat/local.ts). */
const TEMPLATE_KEYS: Record<string, { root: number; mode: 'major' | 'minor' }> = {
  trap: { root: 5, mode: 'minor' },
  drill: { root: 5, mode: 'minor' },
  'boom-bap': { root: 9, mode: 'minor' },
  lofi: { root: 9, mode: 'minor' },
  house: { root: 9, mode: 'major' },
};

const services: Services[] = [];
afterAll(async () => {
  for (const s of services) await s.engine.dispose();
});

/** Each template is rendered once per file: the analysis tests and the analyzer test share the audio. */
const rendered = new Map<string, ReturnType<typeof renderTemplateOnce>>();
function renderTemplate(id: string) {
  let r = rendered.get(id);
  if (!r) rendered.set(id, (r = renderTemplateOnce(id)));
  return r;
}

async function renderTemplateOnce(id: string) {
  const s = createServices();
  services.push(s);
  const t = TEMPLATES.find((x) => x.id === id)!;
  const { project } = templateProject(s, t);
  const r = await renderOffline(project, {
    plugins: s.plugins,
    samples: opfsSampleProvider(),
    view: { mode: 'song', patternId: null, loop: null },
    bars: 12,
    sampleRate: RATE,
    tail: 1,
  });
  const channels = [r.buffer.getChannelData(0).slice(), r.buffer.getChannelData(Math.min(1, r.buffer.numberOfChannels - 1)).slice()];
  const songKey = project.transport.key;
  const key = songKey ? { root: songKey.root, mode: songKey.scale === 'minor' ? ('minor' as const) : ('major' as const) } : TEMPLATE_KEYS[id]!;
  return { t, s, channels, start: r.preRoll + r.latency, key };
}

describe('DJ analysis of the project templates', () => {
  const rows: string[] = [];
  afterAll(() => console.log(`template analysis:\n${rows.join('\n')}`));

  for (const id of ['trap', 'boom-bap', 'house', 'lofi', 'drill'])
    it(`${id}: tempo, downbeat and key`, async () => {
      const { t, channels, start, key } = await renderTemplate(id);
      const t0 = performance.now();
      const a = runAnalysis({ hash: id, channels, sampleRate: RATE });
      const ms = performance.now() - t0;
      const barLen = (4 * 60) / t.bpm;
      const off = a.grid ? (((a.grid.firstDownbeat - start) % barLen) + barLen) % barLen : NaN;
      const downbeatErr = Math.min(off, barLen - off);
      rows.push(
        `  ${id}: ${a.grid?.bpm ?? '-'} BPM (want ${t.bpm}), downbeat ${(1000 * downbeatErr).toFixed(1)} ms, ` +
          `key ${a.key ? `${keyName(a.key)} ${a.key.camelot} (${a.key.confidence})` : '-'} (want ${keyName(key)}), ` +
          `${a.lufs.toFixed(1)} LUFS, ${a.truePeakDb.toFixed(1)} dBTP, mix in ${a.mixIn.toFixed(2)} s, ${Math.round(ms)} ms`,
      );
      expect(a.grid).not.toBeNull();
      expect(Math.abs(a.grid!.bpm - t.bpm)).toBeLessThanOrEqual(0.05);
      expect(downbeatErr).toBeLessThan(0.02);
      if (id === 'boom-bap') {
        // Its audio is a bass line on A and D only (i and iv): D minor fits as well. A neighbour on the wheel.
        expect(a.key).not.toBeNull();
        const n = (c: string) => parseInt(c, 10);
        expect(Math.abs(n(a.key!.camelot) - n(camelotOf(key.root, key.mode))) % 11).toBeLessThanOrEqual(1);
      } else if (id === 'lofi') {
        // Its chords are Am7 – Dm7 – G7 – Cmaj7: a turnaround that lands on Cmaj7, so the audio reads as C major as well as
        // A minor (scored on the audio: C major 0.80, A minor 0.67, with or without the leveled mix). The relative keys
        // share a Camelot number (8A and 8B) and mix the same: that is the key the DJ side needs.
        expect(a.key).not.toBeNull();
        expect(parseInt(a.key!.camelot, 10)).toBe(parseInt(camelotOf(key.root, key.mode), 10));
      } else expect(a.key && keyName(a.key)).toBe(keyName(key));
      expect(a.lufs).toBeGreaterThan(-30);
      expect(a.truePeakDb).toBeLessThan(0.5);
    }, 60_000);
});

describe('track analyzer in the browser', () => {
  it('decodes WAV bytes, analyzes in a Worker, caches and reports progress', async () => {
    const { t, s, channels, start } = await renderTemplate('house');
    const wav = encodeWav(channels, RATE, { bitDepth: 16, dither: false, seed: 1 });
    const ref: SampleRef = { id: 'song' as SampleId, name: 'house.wav', source: { kind: 'embedded', hash: 'house-wav', ext: 'wav' } };
    let decodes = 0;
    const an = createTrackAnalyzer({
      storage: memoryAnalysisStorage(),
      decode: async () => {
        decodes++;
        const buffer = await decodeAudio(new OfflineAudioContext(1, 1, RATE), wav.slice().buffer);
        return { channels: [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()], sampleRate: buffer.sampleRate };
      },
    });
    const progress: number[] = [];
    const a = await an.analyze(s, ref, { onProgress: (p) => progress.push(p.fraction) });
    expect(a.grid?.bpm).toBe(t.bpm);
    const barLen = (4 * 60) / t.bpm;
    const off = (((a.grid!.firstDownbeat - start) % barLen) + barLen) % barLen;
    expect(Math.min(off, barLen - off)).toBeLessThan(0.02);
    // Progress from the Worker, in order, to the end.
    expect(progress.length).toBeGreaterThan(5);
    expect(progress[progress.length - 1]).toBe(1);
    expect(an.peek('house-wav')).toBe(a);
    await an.analyze(s, ref);
    expect(decodes).toBe(1);

    // Cancelling a running analysis stops the Worker; the next one still works.
    const c = new AbortController();
    const other: SampleRef = { ...ref, source: { kind: 'embedded', hash: 'house-wav-2', ext: 'wav' } };
    const p = an.analyze(s, other, { signal: c.signal, onProgress: (x) => x.fraction > 0.1 && c.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(an.peek('house-wav-2')).toBeNull();
    expect((await an.analyze(s, other)).grid?.bpm).toBe(t.bpm);
  }, 60_000);
});
