/**
 * Track analysis of a 2-hour WAV (1.3 GB that never exists): the streaming analysis gives the right tempo, key and downbeat in
 * under 150 MB, however long the song. See `dj-long-analysis.test.ts` for how the long songs are made and analyzed.
 */
import { describe, expect, it } from 'vitest';
import { analyzer, BAR, BPM, MB, mb, noServices, offBar, refOf, virtualWav, withPeakMemory } from '../helpers/long-analysis';

describe('analysis of songs too long to decode whole (2 hours)', () => {
  it('a 2-hour WAV (1.3 GB that never exists): the same, in under 150 MB', async () => {
    const seconds = 7200;
    const blob = virtualWav(seconds);
    const an = analyzer(blob);
    const { result: a, before, peak, seconds: took } = await withPeakMemory(() => an.analyze(noServices, refOf('6'.repeat(64), seconds, 'wav')));
    console.log(
      `2-hour WAV (${(blob.size / MB).toFixed(0)} MB file): ${took.toFixed(1)} s (${(seconds / took).toFixed(0)}x real time); tab and Workers ${mb(before)} before, peak ${mb(peak)} ` +
        `(+${peak !== null && before !== null ? ((peak - before) / MB).toFixed(0) : 'n/a'} MB); bpm ${a.grid?.bpm}, key ${a.key?.camelot}, ${a.energy.length} bars`,
    );
    expect(Math.abs(a.grid!.bpm - BPM)).toBeLessThanOrEqual(0.05);
    expect(a.key?.camelot).toBe('8A');
    expect(offBar(a.grid!.firstDownbeat)).toBeLessThan(0.01);
    expect(Math.abs(a.energy.length - seconds / BAR)).toBeLessThanOrEqual(2);
    if (peak !== null && before !== null) expect(peak - before).toBeLessThan(150 * MB);
  }, 900_000);
});
