import { describe, expect, it } from 'vitest';
import { makeScenario, type Scenario } from '../../../../test/helpers/align-scenario';
import { attackTime } from '../../../../test/helpers/syllables';
import { cpuNow, perfLimit, settle } from '../../../../test/helpers/perf';
import { trackVoicePitch } from '../../voice/pitch-notes';
import { alignToGuide } from './align';
import { dtwTableBytes } from './dtw';
import { medianDeviationCents } from './pitch-follow';

const SR = 48000;
/** Alignments with pitch tracking take seconds; a machine busy with other tests can take much longer, so these get room. */
const HEAVY_MS = 240_000;
/** The attack of a syllable is searched this far either side of where the lead starts it (the syllables are 0.55 s apart). */
const SPAN_SEC = 0.06;

interface RunOptions {
  tightness?: number;
  pitch?: number;
  channels?: number;
}

/** Runs the whole alignment of a scenario's double onto its lead. */
function align(s: Scenario, opts: RunOptions = {}) {
  const audible = { fromSec: 0, toSec: s.seconds };
  const channels = opts.channels === 2 ? [s.double, s.double] : [s.double];
  return alignToGuide({
    channels,
    sampleRate: SR,
    audible,
    guide: { mono: s.lead, sampleRate: SR, audible },
    tightness: opts.tightness ?? 100,
    pitch: opts.pitch ?? 0,
  });
}

/** How far (ms) each syllable's attack in `x` is from the lead's, looking near the lead's start. */
function onsetErrorsMs(s: Scenario, x: Float32Array): number[] {
  return s.leadStarts.map((t) => (attackTime(x, SR, t, SPAN_SEC) - attackTime(s.lead, SR, t, SPAN_SEC)) * 1000);
}

const worst = (values: number[]) => Math.max(...values.map(Math.abs));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] as number;

describe('alignToGuide: timing', () => {
  it('puts every onset of a double within 10 ms of the lead (±80 ms jitter, ±15 % lengths, three doubles)', { timeout: HEAVY_MS }, () => {
    for (const seed of [1, 3, 4]) {
      const s = makeScenario({ sampleRate: SR, seed, jitterSec: 0.08, stretch: 0.15 });
      const errors = onsetErrorsMs(s, align(s).channels[0] as Float32Array);
      expect(worst(errors), `seed ${seed}: ${errors.map((e) => e.toFixed(1)).join(' ')}`).toBeLessThan(10);
    }
  });

  it('first brings a double that comes in 300 ms late (or 250 ms early) onto the lead', { timeout: HEAVY_MS }, () => {
    for (const offsetSec of [0.3, -0.25]) {
      const s = makeScenario({ sampleRate: SR, seed: 6, jitterSec: 0.06, offsetSec });
      const errors = onsetErrorsMs(s, align(s).channels[0] as Float32Array);
      expect(worst(errors), `offset ${offsetSec}: ${errors.map((e) => e.toFixed(1)).join(' ')}`).toBeLessThan(10);
    }
  });

  it('follows the lead more closely as tightness goes up, and at 0 only fixes the big offsets', { timeout: HEAVY_MS }, () => {
    const s = makeScenario({ sampleRate: SR, seed: 5, jitterSec: 0.03, offsetSec: 0.2 });
    const medianError = (tightness: number) =>
      median(onsetErrorsMs(s, align(s, { tightness }).channels[0] as Float32Array).map(Math.abs));
    const loose = medianError(0);
    const middle = medianError(50);
    const tight = medianError(100);
    expect(loose).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(tight);
    // The 200 ms offset is mostly gone even at 0 (what is left is the dead zone), and 100 is syllable-tight.
    expect(loose).toBeLessThan(80);
    expect(tight).toBeLessThan(5);
  });

  it('works on stereo: both channels move together', { timeout: HEAVY_MS }, () => {
    const s = makeScenario({ sampleRate: SR, seed: 2, syllables: 6 });
    const out = align(s, { channels: 2 });
    expect(out.channels[0]).toEqual(out.channels[1]);
    expect(worst(onsetErrorsMs(s, out.channels[0] as Float32Array))).toBeLessThan(10);
  });

  it('works across sample rates: a lead at 44.1 kHz guides a clip at 48 kHz', { timeout: HEAVY_MS }, () => {
    const s = makeScenario({ sampleRate: SR, seed: 2, syllables: 6 });
    const guide = makeScenario({ sampleRate: 44100, seed: 2, syllables: 6 });
    const audible = { fromSec: 0, toSec: s.seconds };
    const mixed = alignToGuide({
      channels: [s.double],
      sampleRate: SR,
      audible,
      guide: { mono: guide.lead, sampleRate: 44100, audible },
      tightness: 100,
      pitch: 0,
    });
    expect(worst(onsetErrorsMs(s, mixed.channels[0] as Float32Array))).toBeLessThan(10);
  });

  it('leaves the clip alone when it and the guide do not overlap', () => {
    const s = makeScenario({ sampleRate: SR, seed: 1 });
    const out = alignToGuide({
      channels: [s.double],
      sampleRate: SR,
      audible: { fromSec: 0, toSec: 2 },
      guide: { mono: s.lead, sampleRate: SR, audible: { fromSec: 4, toSec: 6 } },
      tightness: 100,
      pitch: 100,
    });
    expect(out.stats.overlapSec).toBe(0);
    expect(out.channels[0]).toEqual(s.double);
  });

  it('is deterministic: the same input renders the same samples', () => {
    const s = makeScenario({ sampleRate: SR, seed: 4, detuneCents: 25 });
    const a = align(s, { pitch: 80 });
    const b = align(s, { pitch: 80 });
    expect(Buffer.from((a.channels[0] as Float32Array).buffer).equals(Buffer.from((b.channels[0] as Float32Array).buffer))).toBe(true);
    expect(a.lagSec).toEqual(b.lagSec);
  });
});

describe('alignToGuide: sound quality', () => {
  it('has no clicks at the joins: the largest step stays within 1.5× the voice’s own, nothing goes over', () => {
    const s = makeScenario({ sampleRate: SR, seed: 3 });
    const x = align(s).channels[0] as Float32Array;
    const steepest = (v: Float32Array) => {
      let m = 0;
      for (let i = 1; i < v.length; i++) m = Math.max(m, Math.abs((v[i] as number) - (v[i - 1] as number)));
      return m;
    };
    expect(steepest(x)).toBeLessThan(1.5 * steepest(s.double));
    expect(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThan(1);
  });

  it('keeps consonants sharp: a burst keeps its peak and its length', () => {
    const s = makeScenario({ sampleRate: SR, seed: 3 });
    const x = align(s).channels[0] as Float32Array;
    const burst = (v: Float32Array, at: number) => {
      const from = Math.round((at - 0.004) * SR);
      let peak = 0;
      for (let i = from; i < from + Math.round(0.02 * SR); i++) peak = Math.max(peak, Math.abs(v[i] as number));
      return peak;
    };
    let kept = 0;
    s.leadStarts.forEach((t, k) => {
      const original = burst(s.double, s.doubleStarts[k] as number);
      const moved = burst(x, attackTime(s.lead, SR, t, SPAN_SEC) - 0.0005);
      if (moved > 0.8 * original && moved < 1.25 * original) kept++;
    });
    expect(kept).toBeGreaterThanOrEqual(9);
  });

  it('keeps the pitch when only time is aligned', () => {
    const s = makeScenario({ sampleRate: SR, seed: 1, detuneCents: 30 });
    const before = trackVoicePitch(s.double, SR);
    const after = trackVoicePitch(align(s, { pitch: 0 }).channels[0] as Float32Array, SR);
    const lead = trackVoicePitch(s.lead, SR);
    // Against the lead the deviation is what it was (the notes are the same, just moved).
    const was = medianDeviationCents(lead.f0, aligned(s.double, s, before.f0), lead.hop);
    const is = medianDeviationCents(lead.f0, after.f0, lead.hop);
    expect(Math.abs(is - was)).toBeLessThan(6);
  });
});

/** The double's own pitch track moved onto the lead's timeline (by the true syllable starts), for comparing pitch alone. */
function aligned(_double: Float32Array, s: Scenario, f0: Float32Array): Float32Array {
  const hop = 0.005;
  const out = new Float32Array(f0.length);
  s.leadStarts.forEach((leadStart, k) => {
    const from = Math.round((s.doubleStarts[k] as number) / hop);
    const to = Math.round(((s.doubleStarts[k] as number) + 0.3) / hop);
    const shift = Math.round((leadStart - (s.doubleStarts[k] as number)) / hop);
    for (let i = from; i < to && i + shift < out.length; i++) if (i + shift >= 0) out[i + shift] = f0[i] as number;
  });
  return out;
}

describe('alignToGuide: pitch', () => {
  it('brings the median pitch error under 10 cents at 100 % (doubles sung up to 35 cents off, no vibrato)', { timeout: HEAVY_MS }, () => {
    for (const seed of [1, 2]) {
      const s = makeScenario({ sampleRate: SR, seed, detuneCents: 35 });
      const out = align(s, { pitch: 100 });
      const lead = trackVoicePitch(s.lead, SR);
      const heard = trackVoicePitch(out.channels[0] as Float32Array, SR);
      const cents = medianDeviationCents(lead.f0, heard.f0, lead.hop);
      expect(cents, `seed ${seed}`).toBeLessThan(10);
      expect(out.stats.pitchCentsAfter as number).toBeLessThan(10);
      expect(out.stats.pitchCentsBefore as number).toBeGreaterThan(out.stats.pitchCentsAfter as number);
    }
  });

  it('corrects only the share asked for: 50 % lands between the original and the guide', { timeout: HEAVY_MS }, () => {
    const s = makeScenario({ sampleRate: SR, seed: 1, detuneCents: 35 });
    const half = align(s, { pitch: 50 }).stats;
    const full = align(s, { pitch: 100 }).stats;
    expect(half.pitchCentsAfter as number).toBeGreaterThan(full.pitchCentsAfter as number);
    expect(half.pitchCentsAfter as number).toBeLessThan(half.pitchCentsBefore as number);
  });

  it('keeps a harmony’s interval: a double a major third above stays a major third above', { timeout: HEAVY_MS }, () => {
    const lead = makeScenario({ sampleRate: SR, seed: 2, detuneCents: 0 });
    const above = makeScenario({ sampleRate: SR, seed: 2, detuneCents: 30, jitterSec: 0.04 });
    // The same notes four semitones up: resample the double (pitch ×2^(4/12)) with a matching shift of its syllable starts.
    const ratio = Math.pow(2, 4 / 12);
    const up = new Float32Array(Math.floor(above.double.length / ratio));
    for (let i = 0; i < up.length; i++) {
      const at = i * ratio;
      const j = Math.floor(at);
      up[i] = (above.double[j] as number) * (1 - (at - j)) + (above.double[j + 1] as number) * (at - j);
    }
    const audible = { fromSec: 0, toSec: up.length / SR };
    const out = alignToGuide({
      channels: [up],
      sampleRate: SR,
      audible,
      guide: { mono: lead.lead, sampleRate: SR, audible: { fromSec: 0, toSec: lead.seconds } },
      tightness: 100,
      pitch: 100,
    });
    const interval = (x: Float32Array) => {
      const f = trackVoicePitch(x, SR).f0;
      const g = trackVoicePitch(lead.lead, SR).f0;
      const diffs: number[] = [];
      for (let i = 0; i < Math.min(f.length, g.length); i++) {
        if ((f[i] as number) > 0 && (g[i] as number) > 0) diffs.push(1200 * Math.log2((f[i] as number) / (g[i] as number)));
      }
      return median(diffs);
    };
    // About 400 cents above the lead (the resampling also changed the syllables' lengths, but not the notes' relation).
    expect(Math.abs(interval(out.channels[0] as Float32Array) - 400)).toBeLessThan(25);
    expect(out.stats.pitchCentsAfter as number).toBeLessThan(15);
  });
});

describe('alignToGuide: long clips', () => {
  it('holds the match in a band: a 3-minute clip needs 7.5 MB of trace, not 1.3 GB, and a time limit that scales linearly', () => {
    const frames = Math.ceil(180 / 0.005) + 1;
    expect(dtwTableBytes(frames, 100)).toBeLessThan(8e6);
    expect(dtwTableBytes(2 * frames, 100)).toBe(2 * dtwTableBytes(frames, 100));
  });

  it('aligns a 3-minute clip within a bounded amount of memory and about 3× real time or better', { tags: ['perf'], timeout: 180_000 }, async () => {
    const parts = Array.from({ length: 30 }, (_, i) => makeScenario({ sampleRate: SR, seed: i + 1 }));
    const total = parts.reduce((n, p) => n + p.lead.length, 0);
    const lead = new Float32Array(total);
    const double = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      lead.set(p.lead, at);
      double.set(p.double, at);
      at += p.lead.length;
    }
    const audible = { fromSec: 0, toSec: total / SR };
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    let out: ReturnType<typeof alignToGuide> | null = null;
    const cpuMs = await settle(
      () => {
        const t0 = cpuNow();
        out = alignToGuide({
          channels: [double],
          sampleRate: SR,
          audible,
          guide: { mono: lead, sampleRate: SR, audible },
          tightness: 100,
          pitch: 100,
          onProgress: () => {
            peak = Math.max(peak, process.memoryUsage().arrayBuffers);
          },
        });
        return cpuNow() - t0;
      },
      (ms) => ms < perfLimit(15_000, 60_000),
      { attempts: 2 },
    );
    // The clip is 36 MB of floats; the whole run stays within a small multiple of that (measured 218 MB).
    expect((peak - baseline) / 1e6).toBeLessThan(400);
    expect(cpuMs).toBeLessThan(perfLimit(15_000, 60_000));
    const result = out as unknown as ReturnType<typeof alignToGuide>;
    expect(result.channels[0]?.length).toBe(double.length);
    expect(result.stats.pitchCentsAfter as number).toBeLessThan(10);
  });
});
