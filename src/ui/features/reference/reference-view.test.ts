import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@core/model/defaults';
import { compareTone } from '@core/reference/bands';
import { FAKE_BANDS, fakeReference } from '@core/reference/fixtures';
import { bandFill, bandRows, factRows, referenceStrip, stripParts } from './reference-view';

describe('what the Reference window shows', () => {
  it('draws both strips on one scale: widths are bars', () => {
    const ref = fakeReference();
    const parts = stripParts(referenceStrip(ref), 96);
    expect(parts.map((p) => [p.label, Math.round(p.widthPct)])).toEqual([
      ['Intro', 17],
      ['Drop', 33],
      ['Break', 17],
      ['Drop', 33],
    ]);
    // A shorter song of 48 bars takes half the width of the 96-bar scale.
    expect(stripParts([{ label: 'Verse', bars: 48, energy: 0.5, kind: 'verse' }], 96)[0]!.widthPct).toBe(50);
  });

  it('shows the balance of the reference’s loud parts, and the mix next to it once it was heard', () => {
    const ref = fakeReference();
    expect(bandRows(ref, null).every((r) => r.mixDb === null && r.diffDb === null && !r.off)).toBe(true);
    const mix = FAKE_BANDS.map((b, i) => (i === 1 ? b - 5 : b));
    const rows = bandRows(ref, compareTone(mix, FAKE_BANDS));
    expect(rows.filter((r) => r.off).map((r) => r.id)).toEqual(['bass']);
    expect(rows[1]!.diffDb).toBeCloseTo(-5, 0);
    expect(bandFill(0)).toBe(1);
    expect(bandFill(-60)).toBe(0);
    expect(bandFill(-22.5)).toBeCloseTo(0.5);
  });

  it('puts tempo, key, loudness and width side by side', () => {
    const p = createEmptyProject();
    p.transport.bpm = 140;
    p.transport.key = { root: 5, scale: 'minor' };
    const rows = factRows(p, fakeReference(), null);
    expect(rows.map((r) => [r.label, r.reference, r.mine])).toEqual([
      ['Tempo', '128 BPM', '140 BPM (+12)'],
      ['Key', 'A minor (8A)', 'F minor'],
      ['Loudness', '−8.0 LUFS', '—'],
      ['True peak', '−0.9 dBTP', '—'],
      ['Stereo width', '0.40', '—'],
    ]);
    const heard = factRows(p, fakeReference(), { lufs: -11.2, truePeakDb: -1.3, width: 0.55 });
    expect(heard.map((r) => r.mine)).toEqual(['140 BPM (+12)', 'F minor', '−11.2 LUFS', '−1.3 dBTP', '0.55']);
    expect(rows.every((r) => r.hint.length > 20)).toBe(true);
  });

  it('says so when the reference has no tempo or key', () => {
    const rows = factRows(createEmptyProject(), fakeReference({ bpm: null, key: null }), null);
    expect(rows[0]!.reference).toBe('no steady beat');
    expect(rows[1]!.reference).toBe('not found');
    expect(rows[1]!.mine).toBe('not set');
  });
});
