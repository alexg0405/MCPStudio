/**
 * Track analysis of songs too long to decode whole (headless Chrome): the file is read by ranges (WAV from its bytes, MP3
 * through `decodeAudioData` a few seconds at a time on this thread), handed to the analysis Worker in chunks and analyzed
 * as it goes by (`app/dj/analysis-stream*.ts`). This file checks a 30-minute WAV (a file that has no bytes: any range is made on
 * demand): that the result is right (tempo, key, downbeat, loudness), how much memory the tab and its Workers use while it
 * runs and how long it takes, that cancelling stops it, and that a deck gets its grid when the analysis of its song finishes.
 * The 2-hour WAV (`dj-long-analysis-2h.test.ts`) and the 13-minute MP3 (`dj-long-analysis-mp3.test.ts`) are files of their own
 * (helpers in `test/helpers/long-analysis.ts`), so the three long analyses run side by side.
 *
 * `VITE_LONG_COMPARE=1` also analyzes the 30-minute WAV the old way (decoded whole) for the before/after numbers.
 */
import { describe, expect, it } from 'vitest';
import { createDecks, type DecksDeps } from '@app/dj/decks';
import { loudness, runAnalysis } from '@app/dj/analysis-run';
import type { DeckHost } from '@engine/api';
import { SampleCache } from '@engine/samples';
import {
  analyzer,
  agentMemory,
  base,
  BAR,
  BPM,
  MB,
  mb,
  noServices,
  offBar,
  RATE,
  refOf,
  virtualWav,
  withPeakMemory,
} from '../helpers/long-analysis';

const compare = (import.meta.env as Record<string, string | undefined>).VITE_LONG_COMPARE === '1';

describe('analysis of songs too long to decode whole', () => {
  it('a 30-minute WAV: right tempo, key, downbeat and loudness, in bounded memory', async () => {
    const seconds = 1800;
    const blob = virtualWav(seconds);
    const an = analyzer(blob);
    const progress: number[] = [];
    const { result: a, before, peak, seconds: took } = await withPeakMemory(() =>
      an.analyze(noServices, refOf('1'.repeat(64), seconds, 'wav'), { onProgress: (p) => progress.push(p.fraction) }),
    );
    const own = loudness([base.l, base.r], RATE);
    console.log(
      `30-minute WAV (${(blob.size / MB).toFixed(0)} MB file): ${took.toFixed(1)} s (${(seconds / took).toFixed(0)}x real time); tab and Workers ${mb(before)} before, peak ${mb(peak)} ` +
        `(+${peak !== null && before !== null ? ((peak - before) / MB).toFixed(0) : 'n/a'} MB); bpm ${a.grid?.bpm}, key ${a.key?.camelot}, first downbeat ${a.grid?.firstDownbeat}, ` +
        `${a.lufs.toFixed(2)} LUFS (the song alone ${own.lufs.toFixed(2)}), ${a.truePeakDb.toFixed(2)} dBTP, ${a.energy.length} bars, ${a.sections.length} sections`,
    );
    expect(a.durationSec).toBeCloseTo(seconds, 2);
    expect(a.grid).not.toBeNull();
    expect(Math.abs(a.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
    expect(a.grid!.beatsPerBar).toBe(4);
    expect(offBar(a.grid!.firstDownbeat)).toBeLessThan(0.01);
    expect(a.key?.camelot).toBe('8A');
    expect(Math.abs(a.lufs - own.lufs)).toBeLessThan(0.1);
    expect(Math.abs(a.truePeakDb - own.truePeakDb)).toBeLessThan(0.1);
    expect(Math.abs(a.energy.length - seconds / BAR)).toBeLessThanOrEqual(2);
    expect(a.mixOut).toBeGreaterThan(seconds - 60);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1]!)).toBe(true);
    expect(took).toBeLessThan(600);
    // The song decoded whole would be 635 MB of floats (and as much again in copies): the streaming run stays far below that.
    if (peak !== null && before !== null) expect(peak - before).toBeLessThan(250 * MB);
  }, 900_000);

  it('cancelling stops the reading and the Worker, and the next analysis still works', async () => {
    const seconds = 1500;
    const blob = virtualWav(seconds);
    const an = analyzer(blob);
    const c = new AbortController();
    const t0 = performance.now();
    const doomed = an.analyze(noServices, refOf('3'.repeat(64), seconds, 'wav'), { signal: c.signal, onProgress: (p) => p.fraction > 0.1 && c.abort() });
    await expect(doomed).rejects.toMatchObject({ name: 'AbortError' });
    console.log(`cancelled after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    expect(an.peek('3'.repeat(64))).toBeNull();
    const again = await an.analyze(noServices, refOf('4'.repeat(64), 900, 'wav'));
    expect(Math.abs(again.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
  }, 600_000);

  if (compare)
    it('before: the 30-minute WAV decoded whole (the old way), for the numbers', async () => {
      const blob = virtualWav(1800);
      const t0 = performance.now();
      const start = await agentMemory();
      const bytes = new Uint8Array(await blob.slice(0, blob.size).arrayBuffer());
      const buffer = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(bytes.slice().buffer);
      const channels = [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()];
      // What the analysis holds when it starts: the file's bytes, the decoded buffer and the copies the analyzer keeps.
      const held = await agentMemory();
      const a = runAnalysis({ hash: 'old', channels, sampleRate: RATE });
      const took = (performance.now() - t0) / 1000;
      // runAnalysis then adds a mono mix (4 bytes a frame) and its 22 kHz copy (2) and the features (~20 MB per 15 minutes).
      const extra = buffer.length * 6 + 70 * MB;
      console.log(
        `BEFORE, 30-minute WAV decoded whole: ${took.toFixed(1)} s on this thread; tab ${mb(start)} before, ${mb(held)} when the analysis starts ` +
          `(bytes + decoded buffer + copies), about ${mb(held === null ? null : held + extra)} at its peak; bpm ${a.grid?.bpm}, key ${a.key?.camelot}`,
      );
    }, 900_000);
});

describe('a deck gets its grid when the analysis of its long song finishes', () => {
  it('loads at once without a grid, shows the progress, then has the tempo, the cue on the first downbeat and a sync-able grid', async () => {
    const seconds = 900;
    const blob = virtualWav(seconds);
    const ref = refOf('5'.repeat(64), seconds, 'wav');
    const an = analyzer(blob);
    const ctx = new OfflineAudioContext(2, Math.round(4 * 48000), 48000);
    const host: DeckHost = { ctx, output: ctx.destination, loadModule: (u) => ctx.audioWorklet.addModule(u), heardTime: () => ctx.currentTime };
    const toasts: string[] = [];
    const deps: DecksDeps = {
      host: () => host,
      subscribeHost: () => () => {},
      resume: async () => {},
      cache: new SampleCache({ getBytes: async () => null }),
      openFile: async () => blob,
      peekAnalysis: (r) => an.peek(r.source.kind === 'embedded' ? r.source.hash : ''),
      analysis: (r, o) => an.analyze(noServices, r, { ...(o?.signal ? { signal: o.signal } : {}), ...(o?.onProgress ? { onProgress: (p) => o.onProgress?.(p.fraction) } : {}) }),
      addRecording: async () => null,
      toast: (m) => void toasts.push(m),
    };
    const decks = createDecks(deps);
    await decks.load('A', ref, 'Fifteen minutes');
    const deck = () => decks.store.getState().decks.A;
    // Ready to play at once: no grid yet, the analysis running behind it.
    expect(deck().loading).toBe(false);
    expect(deck().baseBpm).toBeNull();
    expect(deck().analyzing).not.toBeNull();
    const seen: number[] = [];
    const unsub = decks.store.subscribe((s) => {
      const f = s.decks.A.analyzing;
      if (f !== null) seen.push(f);
    });
    const t0 = performance.now();
    while (deck().baseBpm === null && performance.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 100));
    unsub();
    console.log(`deck: grid after ${((performance.now() - t0) / 1000).toFixed(1)} s more; progress steps seen ${seen.length}`);
    expect(toasts).toEqual([]);
    expect(Math.abs(deck().baseBpm! - BPM)).toBeLessThanOrEqual(0.05);
    expect(deck().bpm).toBeCloseTo(deck().baseBpm!, 6);
    expect(deck().analyzing).toBeNull();
    expect(offBar(deck().cuePoint)).toBeLessThan(0.01);
    expect(decks.analysisOf?.('A')?.key?.camelot).toBe('8A');
    expect(decks.waveformOf?.('A')).not.toBeNull();
    // Ejecting while a long song is being analyzed stops the work.
    decks.eject('A');
    expect(deck().analyzing).toBeNull();
  }, 600_000);
});
