/**
 * Track analysis of a 13-minute MP3 made with the app's own encoder, decoded in pieces on this thread: the streaming analysis
 * gives what analyzing the whole decoded file gives. See `dj-long-analysis.test.ts` for how the long songs are analyzed.
 */
import { describe, expect, it } from 'vitest';
import { runAnalysis } from '@app/dj/analysis-run';
import { analyzer, BPM, expectSame, MB, mb, mp3Of, noServices, offBar, RATE, refOf, withPeakMemory } from '../helpers/long-analysis';

describe('analysis of songs too long to decode whole (MP3)', () => {
  it('a 13-minute MP3 (the app’s encoder, decoded in pieces on this thread): what the whole decoded file gives', async () => {
    const seconds = 13 * 60;
    const t0 = performance.now();
    const blob = mp3Of(seconds);
    console.log(`13-minute MP3: ${(blob.size / MB).toFixed(1)} MB made in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const an = analyzer(blob);
    const { result: a, before, peak, seconds: took } = await withPeakMemory(() => an.analyze(noServices, refOf('2'.repeat(64), seconds, 'mp3')));
    console.log(
      `13-minute MP3: ${took.toFixed(1)} s (${(seconds / took).toFixed(0)}x real time); tab and Workers ${mb(before)} before, peak ${mb(peak)}; ` +
        `bpm ${a.grid?.bpm}, key ${a.key?.camelot}, first downbeat ${a.grid?.firstDownbeat}, ${a.lufs.toFixed(2)} LUFS`,
    );
    expect(Math.abs(a.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
    expect(a.key?.camelot).toBe('8A');
    expect(offBar(a.grid!.firstDownbeat)).toBeLessThan(0.03);
    // The whole file decoded at 44.1 kHz and analyzed the old way.
    const buffer = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(await blob.arrayBuffer());
    const whole = runAnalysis({ hash: 'w', channels: [buffer.getChannelData(0), buffer.getChannelData(1)], sampleRate: RATE });
    expectSame(a, whole);
  }, 900_000);
});
