import { describe, expect, it } from 'vitest';
import { previewPlan, type PreviewSettings } from './preview';
import { SAMPLE_ANALYSIS_VERSION, type SampleAnalysis } from './types';

const a = (over: Partial<SampleAnalysis>): SampleAnalysis => ({
  v: SAMPLE_ANALYSIS_VERSION,
  kind: 'one-shot',
  durationSec: 0.5,
  category: 'kick',
  confidence: 0.9,
  loudnessDb: -10,
  peakDb: -1,
  brightness: 200,
  vec: [],
  ...over,
});
const on: PreviewSettings = { syncTempo: true, syncMode: 'stretch', inKey: true };
const project = { bpm: 128, key: { root: 0 } };

describe('audition plan', () => {
  it('plays a plain one-shot as it is', () => {
    expect(previewPlan(a({}), on, project)).toEqual({ opts: {}, notes: [] });
    expect(previewPlan(null, on, project)).toEqual({ opts: {}, notes: [] });
  });

  it('loops a loop to the project tempo by stretching (the pitch stays) and waits for the next beat', () => {
    const p = previewPlan(a({ kind: 'loop', category: null, bpm: 120 }), on, project);
    expect(p.opts.loop).toBe(true);
    expect(p.opts.onBeat).toBe(true);
    expect(p.opts.stretch).toBeCloseTo(120 / 128, 10);
    expect(p.opts.rate).toBeUndefined();
    expect(p.notes[0]).toBe('stretched from 120 to 128 BPM');
  });

  it('can resample instead (the pitch follows the speed like a turntable)', () => {
    const p = previewPlan(a({ kind: 'loop', category: null, bpm: 120 }), { ...on, syncMode: 'resample' }, project);
    expect(p.opts.rate).toBeCloseTo(128 / 120, 10);
    expect(p.opts.stretch).toBeUndefined();
    expect(p.notes[0]).toContain('resampled');
  });

  it('plays a loop at its own tempo, still looping, when sync is off or it has no tempo', () => {
    expect(previewPlan(a({ kind: 'loop', category: null, bpm: 120 }), { ...on, syncTempo: false }, project)).toEqual({ opts: { loop: true }, notes: [] });
    expect(previewPlan(a({ kind: 'loop', category: null }), on, project)).toEqual({ opts: { loop: true }, notes: [] });
  });

  it('takes a half or double reading as the tempo it is: a loop read at 87 in a 172 BPM song is not slowed to half', () => {
    const half = previewPlan(a({ kind: 'loop', category: null, bpm: 87 }), on, { bpm: 174 });
    expect(half.opts).toEqual({ loop: true, onBeat: true });
    const dbl = previewPlan(a({ kind: 'loop', category: null, bpm: 174 }), on, { bpm: 90 });
    expect(dbl.opts.stretch).toBeCloseTo(87 / 90, 10);
    const near = previewPlan(a({ kind: 'loop', category: null, bpm: 174 }), on, { bpm: 85 });
    expect(near.opts.stretch).toBeCloseTo(87 / 85, 5);
  });

  it('leaves a loop already at the project tempo alone but still waits for the beat', () => {
    const p = previewPlan(a({ kind: 'loop', category: null, bpm: 128 }), on, project);
    expect(p.opts).toEqual({ loop: true, onBeat: true });
  });

  it('moves a tonal one-shot onto the tonic of the song key by the shortest turn, when asked', () => {
    const e = previewPlan(a({ category: 'tonal', root: 4 }), on, project);
    expect(e.opts.rate).toBeCloseTo(Math.pow(2, -4 / 12), 10);
    expect(e.notes[0]).toBe('down 4 semitones to the song key');
    const a9 = previewPlan(a({ category: '808', root: 9 }), on, project);
    expect(a9.opts.rate).toBeCloseTo(Math.pow(2, 3 / 12), 10);
    expect(a9.notes[0]).toBe('up 3 semitones to the song key');
    expect(previewPlan(a({ category: 'tonal', root: 4 }), { ...on, inKey: false }, project).opts).toEqual({});
    expect(previewPlan(a({ category: 'tonal', root: 4 }), on, { bpm: 120 }).opts).toEqual({});
    expect(previewPlan(a({ category: 'tonal', root: 0 }), on, project).opts).toEqual({});
  });

  it('never tunes drums', () => {
    expect(previewPlan(a({ category: 'kick', root: 4 }), on, project).opts).toEqual({});
    expect(previewPlan(a({ category: 'hat', root: 4 }), on, project).opts).toEqual({});
  });
});
