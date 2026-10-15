import { describe, expect, it } from 'vitest';
import type { InsertId } from '@core/model/types';
import { BAR, stackedSong } from '../../../test/helpers/focus';
import type { Measurement } from './measure';
import { analysisPlan, formatMixReport, mixNotes, summarizeMixReport, type MixReport } from './mix';

const m = (over: Partial<Measurement> = {}): Measurement => ({
  lufs: -14,
  shortTermMax: -12,
  peakDb: -3,
  truePeakDb: null,
  rmsDb: -15,
  crestDb: 12,
  bands: [10, 20, 25, 25, 15, 5],
  width: 0.2,
  correlation: 0.8,
  silent: false,
  ...over,
});
const track = (name: string, over: Partial<Measurement> = {}) => ({
  insertId: name.toLowerCase() as InsertId,
  name,
  channels: [name],
  m: m(over),
});
const report = (master: Partial<Measurement>, tracks: ReturnType<typeof track>[]): MixReport => ({
  what: '8 s: bars 1–4 of the song',
  seconds: 8,
  master: m({ truePeakDb: -2, ...master }),
  tracks,
  notes: [],
});

describe('what the analysis listens to', () => {
  it('takes just a part when asked: a span of the song, or a pattern on a loop', () => {
    const { s, ids } = stackedSong();
    s.view.getState().setMode('song');
    // Bars 85–88 at 150 BPM: 6.4 s.
    expect(analysisPlan(s, 30, { from: 84 * BAR, to: 88 * BAR })).toMatchObject({ mode: 'song', fromTick: 84 * BAR, bars: 4 });
    // A long part is cut to the first bars that fit.
    expect(analysisPlan(s, 30, { from: 0, to: 64 * BAR })).toMatchObject({ mode: 'song', fromTick: 0, bars: 18 });
    // Notes: their pattern, looped to a few seconds.
    expect(analysisPlan(s, 30, { patternId: ids.patterns.Drop! })).toMatchObject({ mode: 'pattern', patternId: ids.patterns.Drop, bars: 6 });
    // Without a part: the whole song from bar 1 (cut to 30 s).
    expect(analysisPlan(s, 30)).toMatchObject({ mode: 'song', fromTick: 0, bars: 18 });
  });
});

describe('mix findings', () => {
  it('flags loudness, true peak and phase on the master', () => {
    const notes = mixNotes(report({ lufs: -24, truePeakDb: -0.2, correlation: 0.1 }, []));
    expect(notes.some((n) => n.includes('quiet') && n.includes('−24.0 LUFS'))).toBe(true);
    expect(notes.some((n) => n.includes('true peak is −0.2 dBTP'))).toBe(true);
    expect(notes.some((n) => n.includes('correlation is low'))).toBe(true);
    expect(mixNotes(report({ lufs: -6 }, [])).some((n) => n.includes('very loud'))).toBe(true);
  });

  it('finds two loud tracks fighting in the low end, wide bass, clipping and silent tracks', () => {
    const notes = mixNotes(
      report({}, [
        track('03 Kick', { lufs: -16, bands: [40, 30, 10, 10, 5, 5] }),
        track('04 808', { lufs: -15, bands: [50, 30, 10, 5, 3, 2], width: 0.4 }),
        track('05 Lead', { peakDb: 1.5 }),
        track('06 Pad', { silent: true }),
      ]),
    );
    expect(notes).toContain(
      '“808” and “Kick” both live in the low end (below 250 Hz): duck one with the other (sidechain) or give each its own range with EQ.',
    );
    expect(notes.some((n) => n.startsWith('“808” is wide in the low end'))).toBe(true);
    expect(notes.some((n) => n.startsWith('“Lead” peaks above 0 dBFS'))).toBe(true);
    expect(notes).toContain('“Pad” makes no sound in this part.');
  });

  it('writes the report for the AI and a one-line summary', () => {
    const r = report({ lufs: -11.24, truePeakDb: -0.4 }, [track('01 Drums')]);
    r.notes = mixNotes(r);
    const text = formatMixReport(r);
    expect(text).toContain('Analyzed 8 s: bars 1–4 of the song');
    expect(text).toContain('Master (what you hear, after its effects): −11.2 LUFS');
    expect(text).toContain('- 01 Drums (01 Drums): −14.0 LUFS');
    expect(text).toContain('tone: sub 10%, low 20%, lowMid 25%, mid 25%, presence 15%, air 5%');
    expect(summarizeMixReport(r)).toBe('Master −11.2 LUFS, true peak −0.4 dBTP · 1 track · 1 finding');
  });
});
