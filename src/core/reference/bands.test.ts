import { describe, expect, it } from 'vitest';
import { compareTone, mainTone, mixShares, shareDb, toneAdvice, toneLines, TONE_BANDS, TONE_CROSSOVERS } from './bands';
import { fakeReference, FAKE_BANDS } from './fixtures';

const plus = (bands: readonly number[], at: number, db: number) => bands.map((b, i) => (i === at ? b + db : b));

describe('tonal balance', () => {
  it('has a crossover between every pair of bands', () => {
    expect(TONE_CROSSOVERS.length).toBe(TONE_BANDS.length - 1);
    expect([...TONE_CROSSOVERS]).toEqual([...TONE_CROSSOVERS].sort((a, b) => a - b));
  });

  it('shares are dB under the total, floored at −60', () => {
    const s = shareDb([1, 1, 2, 0, 0, 0, 0, 0]);
    expect(s[0]).toBeCloseTo(-6, 0);
    expect(s[2]).toBeCloseTo(-3, 0);
    expect(s[3]).toBe(-60);
    expect(shareDb([0, 0, 0]).every((x) => x === -60)).toBe(true);
  });

  it('averages balances by weight as energy', () => {
    const a = [-3, -60, -60, -60, -60, -60, -60, -60];
    const b = [-60, -3, -60, -60, -60, -60, -60, -60];
    const m = mixShares([
      { bands: a, weight: 3 },
      { bands: b, weight: 1 },
    ]);
    // 3/4 of the energy is in band 0 and 1/4 in band 1: −1.25 dB and −6.0 dB under the total.
    expect(m[0]).toBeCloseTo(-1.25, 0);
    expect(m[1]).toBeCloseTo(-6, 0);
  });

  it('the reference’s main tone is its loud parts, not its intro or break', () => {
    const quiet = [-30, -30, -30, -30, -30, -30, -30, -30];
    const ref = fakeReference({
      sections: [
        { kind: 'intro', bars: 8, energy: 0.2, bands: quiet },
        { kind: 'drop', bars: 8, energy: 1, bands: FAKE_BANDS },
      ],
    });
    expect(mainTone(ref)).toEqual(FAKE_BANDS);
    const none = fakeReference({ sections: [{ kind: 'intro', bars: 8, energy: 0.2, bands: quiet }] });
    expect(mainTone(none)).toEqual(none.bands);
  });
});

describe('comparing the mix with the reference', () => {
  it('finds nothing when the balances match, or differ by 3 dB or less everywhere', () => {
    expect(compareTone(FAKE_BANDS, FAKE_BANDS).off).toEqual([]);
    const close = FAKE_BANDS.map((b, i) => b + (i % 2 ? 2 : -2));
    expect(compareTone(close, FAKE_BANDS).off).toEqual([]);
    expect(toneLines(compareTone(close, FAKE_BANDS))[0]).toMatch(/within 3 dB/);
  });

  it('names a band that is more than 3 dB off, with a plain suggestion', () => {
    // The low end 4 dB lighter (the others unchanged).
    const c = compareTone(plus(FAKE_BANDS, 1, -4), FAKE_BANDS);
    expect(c.off.map((o) => o.band.id)).toEqual(['bass']);
    expect(c.off[0]!.diffDb).toBeCloseTo(-4, 0);
    expect(toneAdvice(c.off[0]!)).toBe(
      'The low end (60–150 Hz) is 4 dB lighter than the reference: bring it up about 4 dB with the kick and bass levels or an EQ band around 100 Hz.',
    );
    const heavier = compareTone(plus(FAKE_BANDS, 6, 5), FAKE_BANDS);
    expect(toneLines(heavier)).toEqual([
      'The highs (5–10 kHz) is 5 dB heavier than the reference: take it down about 5 dB with the hats and a high shelf at 6 kHz.',
    ]);
  });

  it('takes out the overall offset: one heavy band does not make the rest look light', () => {
    // Energy shares sum to a constant: when the bass gets 6 dB more, the others lose a little.
    const mix = FAKE_BANDS.map((b, i) => (i === 1 ? b + 6 : b - 1));
    const c = compareTone(mix, FAKE_BANDS);
    expect(c.off.map((o) => o.band.id)).toEqual(['bass']);
    expect(c.offsetDb).toBeCloseTo(-1, 0);
    expect(c.bands.filter((b) => b.index !== 1).every((b) => Math.abs(b.diffDb) < 0.5)).toBe(true);
  });

  it('lists the biggest difference first and ignores bands that are empty in both', () => {
    const mix = FAKE_BANDS.map((b, i) => (i === 0 ? b - 5 : i === 5 ? b + 8 : b));
    const c = compareTone(mix, FAKE_BANDS);
    expect(c.off.map((o) => o.band.id)).toEqual(['presence', 'sub']);
    // The air of a dark song is silent in both: no finding.
    const dark = FAKE_BANDS.map((b, i) => (i === 7 ? -58 : b));
    const darker = FAKE_BANDS.map((b, i) => (i === 7 ? -52 : b));
    expect(compareTone(darker, dark).off).toEqual([]);
  });
});
