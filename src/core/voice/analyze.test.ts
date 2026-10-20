import { describe, expect, it } from 'vitest';
import { cpuNow, settle } from '../../../test/helpers/perf';
import { analyzeVoice, type VoiceEvent } from './analyze';
import { hzToMidi } from './pitch';
import {
  clipInPlace,
  drumPattern,
  expectedKind,
  mixInto,
  mulberry32,
  noiseFloor,
  renderScore,
  synthBreath,
  synthHat,
  synthHum,
  synthKick,
  type ScoreHit,
} from './test-signals';

const SR = 48000;

interface Matched {
  pairs: { hit: ScoreHit; event: VoiceEvent; errMs: number }[];
  missed: ScoreHit[];
  extra: VoiceEvent[];
}

/** Pairs every true hit with the nearest unused event within 25 ms. */
function match(hits: readonly ScoreHit[], events: readonly VoiceEvent[]): Matched {
  const used = new Set<number>();
  const pairs: Matched['pairs'] = [];
  const missed: ScoreHit[] = [];
  for (const hit of hits) {
    let best = -1;
    for (let i = 0; i < events.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs((events[i] as VoiceEvent).time - hit.time);
      if (d < 0.025 && (best < 0 || d < Math.abs((events[best] as VoiceEvent).time - hit.time))) best = i;
    }
    if (best < 0) missed.push(hit);
    else {
      used.add(best);
      const event = events[best] as VoiceEvent;
      pairs.push({ hit, event, errMs: (event.time - hit.time) * 1000 });
    }
  }
  return { pairs, missed, extra: events.filter((_, i) => !used.has(i)) };
}

/** 16 steps at a random tempo in 100–150 BPM: kicks, snares, hats and hums of 3–5 steps, 8–16 hits. */
function mixedSequence(seed: number, sampleRate = SR): { samples: Float32Array; hits: ScoreHit[]; bpm: number } {
  const rand = mulberry32(seed * 7919);
  const bpm = 100 + Math.floor(rand() * 51);
  const step = 60 / bpm / 4;
  const start = 0.2 + rand() * 0.3;
  const hits: ScoreHit[] = [];
  for (let s = 0; s < 16;) {
    const r = rand();
    const time = start + s * step + (rand() * 2 - 1) * 0.008;
    if (r < 0.86) {
      if (r < 0.15 && hits.length + (16 - s) > 8) {
        s++;
        continue;
      }
      const kind = r < 0.4 ? 'kick' : r < 0.58 ? 'snare' : 'hat';
      const gain = kind === 'kick' ? 0.6 + rand() * 0.35 : kind === 'snare' ? 0.4 + rand() * 0.4 : 0.2 + rand() * 0.35;
      hits.push({ time, kind, gain });
      s++;
    } else {
      const len = 3 + Math.floor(rand() * 3);
      const hz = 80 * Math.pow(2, rand() * 2.3);
      const dur = Math.min(0.6, Math.max(0.25, len * step - 0.03));
      hits.push({ time, kind: 'hum', gain: 0.5 + rand() * 0.4, hum: { hz, durationSec: dur } });
      s += len + 1;
    }
  }
  const score = renderScore(sampleRate, start + 17 * step + 0.5, hits, { noiseDb: -60, seed });
  return { ...score, bpm };
}

function single(sound: Float32Array, at = 0.3, gain = 0.8, sec = 1.2): Float32Array {
  const x = noiseFloor(SR, sec, -65, 5);
  mixInto(x, sound, at, SR, gain);
  return x;
}

describe('analyzeVoice: onsets', () => {
  it.each([
    [100, 'k-h-s-h-k-hks-h-', 0.31],
    [120, 'khshkhshkhshkhsh', 0.25],
    [128, 'k-hhs-h-k-hhs-hh', 0.4],
    [140, 'k-h-s-h-kkh-s-hh', 0.17],
    [150, 'khhhshhhkhkhshhh', 0.22],
  ])('finds every hit within 10 ms at %i BPM (%s)', (bpm, pattern, startSec) => {
    const p = drumPattern({ sampleRate: SR, bpm, startSec, pattern, jitterMs: 8, noiseDb: -60, seed: bpm });
    expect(p.hits.length).toBeGreaterThanOrEqual(8);
    expect(p.hits.length).toBeLessThanOrEqual(16);
    const m = match(p.hits, analyzeVoice(p.samples, SR));
    expect(m.missed).toEqual([]);
    expect(m.extra).toEqual([]);
    for (const { errMs } of m.pairs) expect(Math.abs(errMs)).toBeLessThanOrEqual(10);
  });

  it('times and classifies mixed sequences with hums (12 random sequences)', () => {
    let pairs = 0;
    let correct = 0;
    let worst = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const seq = mixedSequence(seed);
      expect(seq.hits.length).toBeGreaterThanOrEqual(8);
      expect(seq.hits.length).toBeLessThanOrEqual(16);
      const m = match(seq.hits, analyzeVoice(seq.samples, SR));
      expect(m.missed, `seed ${seed} @ ${seq.bpm} BPM`).toEqual([]);
      expect(m.extra, `seed ${seed} @ ${seq.bpm} BPM`).toEqual([]);
      for (const p of m.pairs) {
        worst = Math.max(worst, Math.abs(p.errMs));
        pairs++;
        if (p.event.kind === expectedKind(p.hit.kind)) correct++;
      }
    }
    expect(worst).toBeLessThanOrEqual(10);
    expect(correct / pairs).toBeGreaterThanOrEqual(0.9);
  });

  it('works at other sample rates', () => {
    for (const sr of [44100, 22050, 16000]) {
      const seq = mixedSequence(3, sr);
      const m = match(seq.hits, analyzeVoice(seq.samples, sr));
      expect(m.missed, `${sr} Hz`).toEqual([]);
      expect(m.extra, `${sr} Hz`).toEqual([]);
      for (const p of m.pairs) {
        expect(Math.abs(p.errMs)).toBeLessThanOrEqual(10);
        expect(p.event.kind).toBe(expectedKind(p.hit.kind));
      }
    }
  });

  it('collapses onsets closer than minGapSec', () => {
    const hat = synthHat(SR);
    const x = noiseFloor(SR, 1, -65);
    mixInto(x, hat, 0.3, SR, 0.5);
    mixInto(x, hat, 0.335, SR, 0.5);
    expect(analyzeVoice(x, SR).length).toBe(1);
    const both = analyzeVoice(x, SR, { minGapSec: 0.02 });
    expect(both.map((e) => Math.round(e.time * 1000))).toEqual([300, 335]);
  });

  it('finds quieter hits at higher sensitivity', () => {
    const x = noiseFloor(SR, 1.2, -85);
    mixInto(x, synthKick(SR), 0.2, SR, 0.9);
    mixInto(x, synthHat(SR), 0.7, SR, 0.009); // ~40 dB under the kick
    expect(analyzeVoice(x, SR, { sensitivity: 0 }).map((e) => e.kind)).toEqual(['kick']);
    expect(analyzeVoice(x, SR, { sensitivity: 1 }).map((e) => e.kind)).toEqual(['kick', 'hat']);
  });
});

describe('analyzeVoice: classification and measurements', () => {
  it('measures plausible features, durations and strengths', () => {
    const hits: ScoreHit[] = [
      { time: 0.2, kind: 'kick', gain: 0.9 },
      { time: 0.6, kind: 'snare', gain: 0.6 },
      { time: 1.0, kind: 'hat', gain: 0.4 },
      { time: 1.4, kind: 'hum', gain: 0.7, hum: { hz: 110, durationSec: 0.4 } },
    ];
    const events = analyzeVoice(renderScore(SR, 2.2, hits, { noiseDb: -60 }).samples, SR);
    expect(events.map((e) => e.kind)).toEqual(['kick', 'snare', 'hat', 'tonal']);
    const [kick, snare, hat, hum] = events as [VoiceEvent, VoiceEvent, VoiceEvent, VoiceEvent];
    expect(kick.features.lowRatio).toBeGreaterThan(0.6);
    expect(kick.features.centroid).toBeLessThan(400);
    expect(snare.features.centroid).toBeGreaterThan(1000);
    expect(snare.features.centroid).toBeLessThan(5000);
    expect(hat.features.highRatio).toBeGreaterThan(0.8);
    expect(hat.features.centroid).toBeGreaterThan(6000);
    expect(kick.features.zcr).toBeLessThan(snare.features.zcr);
    expect(snare.features.zcr).toBeLessThan(hat.features.zcr);
    expect(hum.features.periodicity).toBeGreaterThan(0.9);
    expect(hat.features.periodicity).toBeLessThan(0.7);

    expect(kick.duration).toBeGreaterThan(0.12);
    expect(kick.duration).toBeLessThan(0.18);
    expect(hat.duration).toBeGreaterThan(0.025);
    expect(hat.duration).toBeLessThan(0.06);
    expect(hum.duration).toBeGreaterThan(0.35);
    expect(hum.duration).toBeLessThan(0.42);

    expect(Math.max(...events.map((e) => e.strength))).toBe(1);
    for (const e of events) {
      expect(e.strength).toBeGreaterThan(0);
      expect(e.confidence).toBeGreaterThan(0.5);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
    expect(hat.strength).toBeLessThan(kick.strength);
    expect(kick.pitch).toBeNull();
    expect(kick.pitchEnd).toBeNull();
  });

  it('is not fooled by breaths and a quiet noise floor between hits', () => {
    const p = drumPattern({
      sampleRate: SR,
      bpm: 110,
      startSec: 0.2,
      pattern: 'k-h-s-h-k-h-----k-h-s-h-',
      noiseDb: -60,
    });
    mixInto(p.samples, synthBreath(SR, 0.35), 1.75, SR, 0.15);
    mixInto(p.samples, synthBreath(SR, 0.5, 4), 3.6, SR, 0.08);
    const m = match(p.hits, analyzeVoice(p.samples, SR));
    expect(m.missed).toEqual([]);
    expect(m.extra).toEqual([]);
  });

  it('drums mode never returns tonal; tonal mode makes everything tonal', () => {
    const hits: ScoreHit[] = [
      { time: 0.2, kind: 'kick' },
      { time: 0.6, kind: 'hum', hum: { hz: 98, durationSec: 0.4 } },
      { time: 1.2, kind: 'hat', gain: 0.5 },
    ];
    const x = renderScore(SR, 1.6, hits, { noiseDb: -60 }).samples;
    const drums = analyzeVoice(x, SR, { mode: 'drums' });
    expect(drums.length).toBe(3);
    expect(drums.some((e) => e.kind === 'tonal')).toBe(false);
    expect(drums.every((e) => e.pitch === null)).toBe(true);

    const tonal = analyzeVoice(x, SR, { mode: 'tonal' });
    expect(tonal.length).toBe(3);
    expect(tonal.every((e) => e.kind === 'tonal')).toBe(true);
    expect(Math.abs((tonal[1]?.pitch ?? 0) - hzToMidi(98))).toBeLessThan(0.3);
    expect(tonal[2]?.pitch).toBeNull(); // a hat has no pitch
    expect(tonal[2]?.confidence).toBeLessThan(0.5);
  });
});

describe('analyzeVoice: hums', () => {
  it.each([80, 100, 130.8, 164.8, 220, 293.7, 400])('reads a %s Hz hum within 0.3 semitone', (hz) => {
    const events = analyzeVoice(single(synthHum(SR, { hz, durationSec: 0.45 })), SR);
    expect(events.length).toBe(1);
    const e = events[0] as VoiceEvent;
    expect(e.kind).toBe('tonal');
    expect(Math.abs(e.time - 0.3)).toBeLessThanOrEqual(0.01);
    expect(Math.abs((e.pitch as number) - hzToMidi(hz))).toBeLessThan(0.3);
    expect(Math.abs((e.pitchEnd as number) - hzToMidi(hz))).toBeLessThan(0.3);
  });

  it.each([
    [98, 146.8],
    [130.8, 110],
    [82.4, 92.5],
  ])('splits a legato hum %s → %s Hz (no gap) into two notes', (a, b) => {
    const events = analyzeVoice(single(synthHum(SR, { hz: a, durationSec: 0.7, legato: [[b, 0.35]] })), SR);
    expect(events.map((e) => e.kind)).toEqual(['tonal', 'tonal']);
    const [first, second] = events as [VoiceEvent, VoiceEvent];
    expect(Math.abs((first.pitch as number) - hzToMidi(a))).toBeLessThan(0.3);
    expect(Math.abs((second.pitch as number) - hzToMidi(b))).toBeLessThan(0.3);
    expect(Math.abs(second.time - 0.65)).toBeLessThan(0.03);
    expect(first.duration).toBeCloseTo(second.time - first.time, 6);
  });

  it('keeps a legato change of one semitone as one note (the split needs ~1.5)', () => {
    const events = analyzeVoice(single(synthHum(SR, { hz: 110, durationSec: 0.7, legato: [[116.5, 0.35]] })), SR);
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe('tonal');
  });

  it('splits re-articulated notes of the same pitch ("bum-bum")', () => {
    const x = noiseFloor(SR, 1.2, -65);
    mixInto(x, synthHum(SR, { hz: 110, durationSec: 0.25 }), 0.3, SR, 0.7);
    mixInto(x, synthHum(SR, { hz: 110, durationSec: 0.25 }), 0.55, SR, 0.7);
    const events = analyzeVoice(x, SR);
    expect(events.map((e) => e.kind)).toEqual(['tonal', 'tonal']);
    expect(Math.abs((events[1] as VoiceEvent).time - 0.55)).toBeLessThanOrEqual(0.01);
  });

  it('keeps a glide that never settles as one event, with pitchEnd at the end', () => {
    const events = analyzeVoice(single(synthHum(SR, { hz: 110, durationSec: 0.5, glideToHz: 165 })), SR);
    expect(events.length).toBe(1);
    const e = events[0] as VoiceEvent;
    expect(e.kind).toBe('tonal');
    expect((e.pitchEnd as number) - (e.pitch as number)).toBeGreaterThan(1.5);
    expect(Math.abs((e.pitchEnd as number) - hzToMidi(165))).toBeLessThan(1);
    // A downward glide too.
    const down = analyzeVoice(single(synthHum(SR, { hz: 147, durationSec: 0.5, glideToHz: 110 })), SR);
    expect(down.length).toBe(1);
    expect((down[0]?.pitch as number) - (down[0]?.pitchEnd as number)).toBeGreaterThan(1.5);
  });

  it('splits a glide that settles on a new note where it arrives ("booo-oom")', () => {
    const hum = synthHum(SR, { hz: 98, durationSec: 0.6, glideToHz: 130.8, glideStartSec: 0.2, glideEndSec: 0.32 });
    const events = analyzeVoice(single(hum), SR);
    expect(events.length).toBe(2);
    const [first, second] = events as [VoiceEvent, VoiceEvent];
    expect(Math.abs((first.pitch as number) - hzToMidi(98))).toBeLessThan(0.3);
    expect((first.pitchEnd as number) - (first.pitch as number)).toBeGreaterThan(1.5); // it slides
    expect(Math.abs((second.pitch as number) - hzToMidi(130.8))).toBeLessThan(0.3);
    expect(second.time).toBeGreaterThan(0.3 + 0.25);
    expect(second.time).toBeLessThan(0.3 + 0.34);
  });
});

describe('analyzeVoice: robustness', () => {
  it('returns no events for silence or a quiet noise floor', () => {
    expect(analyzeVoice(new Float32Array(SR), SR)).toEqual([]);
    for (const db of [-90, -70, -55]) expect(analyzeVoice(noiseFloor(SR, 2, db, 3), SR)).toEqual([]);
    const x = noiseFloor(SR, 2, -70);
    mixInto(x, synthBreath(SR, 0.6), 0.5, SR, 0.05);
    expect(analyzeVoice(x, SR)).toEqual([]);
  });

  it('still works on clipped input', () => {
    const p = drumPattern({
      sampleRate: SR,
      bpm: 120,
      startSec: 0.2,
      pattern: 'k-h-s-h-k-hks-h-',
      noiseDb: -60,
      tailSec: 0.9,
    });
    mixInto(p.samples, synthHum(SR, { hz: 98, durationSec: 0.5 }), 2.25, SR, 0.8);
    const hits: ScoreHit[] = [...p.hits, { time: 2.25, kind: 'hum' }];
    clipInPlace(p.samples, 10);
    const m = match(hits, analyzeVoice(p.samples, SR));
    expect(m.missed).toEqual([]);
    expect(m.extra).toEqual([]);
    for (const { errMs } of m.pairs) expect(Math.abs(errMs)).toBeLessThanOrEqual(10);
    const correct = m.pairs.filter((q) => q.event.kind === expectedKind(q.hit.kind)).length;
    expect(correct / m.pairs.length).toBeGreaterThanOrEqual(0.9);
  });

  it('does not throw on very short buffers, odd rates or non-finite samples', () => {
    for (const n of [0, 1, 2, 3, 47, 100, 239, 241, 1000]) {
      for (const sr of [8000, 44100, 48000]) {
        const x = Float32Array.from({ length: n }, (_, i) => (i === n >> 1 ? 0.9 : 0.01 * Math.sin(i)));
        expect(() => analyzeVoice(x, sr)).not.toThrow();
      }
    }
    expect(analyzeVoice(new Float32Array(1000).fill(0.5), 0)).toEqual([]);
    expect(analyzeVoice(new Float32Array(1000).fill(0.5), NaN)).toEqual([]);
    const x = single(synthKick(SR));
    x[1000] = NaN;
    x[20000] = Infinity;
    x[30000] = -Infinity;
    const events = analyzeVoice(x, SR);
    expect(events.map((e) => e.kind)).toEqual(['kick']);
    expect(Object.values(events[0]?.features ?? {}).every(Number.isFinite)).toBe(true);
  });

  it('analyses 30 s of 48 kHz audio in well under a second', { tags: ['perf'], timeout: 30_000 }, async () => {
    // Alternating bars of beatbox and hummed bass at 120 BPM.
    const bar = 2;
    const x = noiseFloor(SR, 30, -60, 8);
    const drums = drumPattern({
      sampleRate: SR,
      bpm: 120,
      startSec: 0,
      pattern: 'k-h-s-h-k-hks-h-',
      noiseDb: undefined,
      tailSec: 0.3,
    });
    const notes = [55, 65.4, 73.4, 49];
    for (let b = 0; b < 15; b++) {
      if (b % 2 === 0) mixInto(x, drums.samples, b * bar, SR);
      else
        for (let q = 0; q < 4; q++)
          mixInto(x, synthHum(SR, { hz: notes[q] as number, durationSec: 0.45 }), b * bar + q * 0.5, SR, 0.7);
    }
    let events: VoiceEvent[] = [];
    // CPU time, not the wall clock: on a busy machine the wall clock counts the time spent waiting for a core.
    // The best of up to six runs, stopping at the first that is fast enough (the machine only ever adds time).
    const best = await settle(
      () => {
        const t0 = cpuNow();
        events = analyzeVoice(x, SR);
        return cpuNow() - t0;
      },
      (ms) => ms < 800,
      { attempts: 6 },
    );
    console.info(`analyzeVoice: 30 s at 48 kHz in ${best.toFixed(0)} ms of CPU (best run), ${events.length} events`);
    expect(events.length).toBe(8 * 9 + 7 * 4);
    // The target is ~400 ms in Node; the bound leaves room for a loaded CI machine.
    expect(best).toBeLessThan(800);
  });
});
