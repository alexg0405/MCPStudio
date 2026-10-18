import { describe, expect, it, vi } from 'vitest';
import { MASTER } from '@core/model/types';
import { R } from '@engine/meter/layout';
import { createTestServices } from '../testing';
import { runReadTool } from '../ai/read';
import { LoudnessProbe, probeLoudness } from '../analysis/loudness-probe';
import { resolveTarget } from './targets';

const SR = 48000;

function stereoTone(seconds: number, levels: (second: number) => number, rightGain = 1) {
  const frames = Math.round(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const amplitude = 10 ** (levels(i / SR) / 20);
    left[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / SR);
    right[i] = left[i]! * rightGain;
  }
  return { left, right };
}

describe('LoudnessProbe (the report’s measurer)', () => {
  it('reads a −23 dBFS stereo tone as −23 LUFS with no range, and finds a peak where it is', () => {
    const { left, right } = stereoTone(10, () => -23);
    const r = probeLoudness(left, right, SR);
    expect(r.integrated).toBeCloseTo(-23, 1);
    expect(r.range).toBeLessThan(0.2);
    expect(r.truePeakDb).toBeCloseTo(-23, 0);
    expect(r.correlation).toBeCloseTo(1, 3);
    expect(r.monoLossDb).toBeCloseTo(0, 2);
  });

  it('puts the loudest moments where they are, in seconds', () => {
    // Quiet for 10 s, loud between 10 s and 14 s, quiet again.
    const { left, right } = stereoTone(24, (t) => (t >= 10 && t < 14 ? -14 : -30));
    const r = probeLoudness(left, right, SR);
    expect(r.maxMomentary).toBeCloseTo(-14, 0);
    expect(r.maxMomentarySec).toBeGreaterThan(10.3);
    expect(r.maxMomentarySec).toBeLessThan(14.2);
    // The loudest 3 s window ends inside or just after the loud part.
    expect(r.maxShortTermSec).toBeGreaterThan(12.5);
    expect(r.maxShortTermSec).toBeLessThan(17.2);
    expect(r.truePeakSec).toBeGreaterThan(10);
    expect(r.truePeakSec).toBeLessThan(14);
    // 4 s of loud and 20 s of quiet: a wide range, and the loud part makes the integrated loudness.
    expect(r.range).toBeGreaterThan(8);
  });

  it('takes the audio in pieces and gives the same numbers', () => {
    const { left, right } = stereoTone(8, (t) => -30 + t);
    const whole = probeLoudness(left, right, SR);
    const probe = new LoudnessProbe(SR);
    for (let from = 0; from < left.length; from += 10_000) probe.push(left, right, from, Math.min(left.length, from + 10_000));
    expect(probe.result().integrated).toBeCloseTo(whole.integrated, 6);
    expect(probe.result().truePeakDb).toBeCloseTo(whole.truePeakDb, 6);
  });

  it('measures opposite polarity as −1 and silence as nothing', () => {
    const { left, right } = stereoTone(5, () => -20, -1);
    const r = probeLoudness(left, right, SR);
    expect(r.correlation).toBeCloseTo(-1, 3);
    expect(r.monoLossDb).toBeLessThan(-30);
    const quiet = probeLoudness(new Float32Array(SR), new Float32Array(SR), SR);
    expect(quiet.integrated).toBe(-Infinity);
    expect(quiet.truePeakSec).toBeNull();
  });
});

describe('MeterService', () => {
  it('opens a meter only while someone holds a lease, and shares one per source', () => {
    const s = createTestServices();
    const meters = s.fakeEngine.meters;
    expect(s.meters.openCount).toBe(0);
    const a = s.meters.listen(MASTER, { full: false });
    void a.meter.readings;
    expect(meters).toHaveLength(1);
    expect(meters[0]?.full).toBe(false);
    // The window asks for full detail on the same source: the same meter, upgraded while it holds the lease.
    const b = s.meters.listen(MASTER, { full: true });
    void b.meter.readings;
    expect(meters).toHaveLength(1);
    expect(meters[0]?.full).toBe(true);
    expect(s.meters.openCount).toBe(1);
    b.release();
    expect(meters[0]?.full).toBe(false);
    expect(meters[0]?.closed).toBe(false);
    a.release();
    expect(meters[0]?.closed).toBe(true);
    expect(s.meters.openCount).toBe(0);
    // Releasing twice changes nothing.
    a.release();
    expect(s.meters.openCount).toBe(0);
  });

  it('restarts the measurement when the song starts playing, if the setting is on', () => {
    const s = createTestServices();
    const lease = s.meters.listen(MASTER, { full: true });
    void lease.meter.readings;
    const meter = s.fakeEngine.meters[0]!;
    s.engine.play();
    expect(meter.resets).toBe(1);
    s.engine.stop();
    s.meters.store.setState({ resetOnPlay: false });
    s.engine.play();
    expect(meter.resets).toBe(1);
    lease.release();
  });

  it('reads the master’s live numbers for Studio, opening a meter the first time', () => {
    const s = createTestServices();
    expect(s.meters.live()).toBeNull();
    expect(s.meters.openCount).toBe(1);
    const meter = s.fakeEngine.meters[0];
    // The lease binds on its first read.
    void s.meters.live();
    const fake = s.fakeEngine.meters[0] ?? meter!;
    fake.readings[R.momentary] = -12.34;
    fake.readings[R.shortTerm] = -13.04;
    fake.readings[R.integrated] = -14.26;
    fake.readings[R.truePeakL] = -2.2;
    fake.readings[R.truePeakR] = -0.97;
    fake.readings[R.correlation] = 0.834;
    const live = s.meters.live()!;
    expect(live).toMatchObject({ momentary: -12.34, integrated: -14.26, truePeakDb: -0.97, correlation: 0.83 });
    const facts = runReadTool(s, 'get_loudness') as { live: { short_term_lufs: number; true_peak_dbtp_since_play: number }; last_report: unknown; target: { lufs: number } };
    expect(facts.live.short_term_lufs).toBe(-13);
    expect(facts.live.true_peak_dbtp_since_play).toBe(-1);
    expect(facts.last_report).toBeNull();
    expect(facts.target.lufs).toBeLessThan(0);
  });

  it('keeps its settings in storage and starts again from them', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    try {
      const s = createTestServices();
      s.meters.store.setState({ target: 'apple', slopeDb: 3 });
      expect(JSON.parse(saved.get('agstudio:meters') ?? '{}')).toMatchObject({ target: 'apple', slopeDb: 3 });
      const again = createTestServices();
      expect(again.meters.store.getState()).toMatchObject({ target: 'apple', slopeDb: 3, resetOnPlay: true });
      saved.set('agstudio:meters', '{not json');
      expect(createTestServices().meters.store.getState().target).toBe('auto');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the target line', () => {
  it('is the reference song’s loudness when there is one, else the style’s, or a streaming preset', () => {
    const s = createTestServices();
    const project = s.doc.getState().project;
    expect(resolveTarget('auto', project).choice).toBe('style');
    expect(resolveTarget('reference', project).choice).toBe('style');
    expect(resolveTarget('streaming', project)).toMatchObject({ lufs: -14 });
    expect(resolveTarget('apple', project).lufs).toBe(-16);
    expect(resolveTarget('broadcast', project).lufs).toBe(-23);
    expect(resolveTarget('none', project).lufs).toBeNull();
    const withReference = { ...project, reference: { lufs: -8.4 } } as unknown as typeof project;
    expect(resolveTarget('auto', withReference)).toMatchObject({ choice: 'reference', lufs: -8.4 });
  });
});
