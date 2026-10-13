import { describe, expect, it } from 'vitest';
import { analyzeVoice, type VoiceEvent, type VoiceKind } from './analyze';
import { describeEvents, estimateBpm, noteName, quantizeToGrid, VOICE_SUMMARY_LEGEND, type GridEvent } from './grid';
import { drumPattern, expectedKind, mulberry32 } from './test-signals';

const SR = 48000;

function ev(time: number, kind: VoiceKind, extra: Partial<VoiceEvent> = {}): VoiceEvent {
  return {
    time,
    duration: 0.05,
    strength: 0.8,
    kind,
    confidence: 0.9,
    pitch: null,
    pitchEnd: null,
    features: { centroid: 0, lowRatio: 0, highRatio: 0, zcr: 0, periodicity: 0 },
    ...extra,
  };
}

function grid(step: number, kind: VoiceKind, extra: Partial<GridEvent> = {}): GridEvent {
  return { ...ev(step * 0.125, kind), step, lengthSteps: 1, offsetMs: 0, ...extra };
}

describe('quantizeToGrid', () => {
  it.each([120, 140])('puts jittered events (±25 ms) on exact steps at %i BPM with startSec ≠ 0', (bpm) => {
    const stepSec = 60 / bpm / 4;
    const startSec = 0.437;
    const rand = mulberry32(bpm);
    const steps = [0, 2, 3, 4, 7, 8, 10, 12, 13, 15, 16, 19, 22, 24, 28, 31];
    const jitter = steps.map(() => (rand() * 2 - 1) * 0.025);
    const events = steps.map((s, i) => ev(startSec + s * stepSec + (jitter[i] as number), 'hat'));
    const q = quantizeToGrid(events, { bpm, startSec });
    expect(q.map((e) => e.step)).toEqual(steps);
    q.forEach((e, i) => expect(e.offsetMs).toBeCloseTo((jitter[i] as number) * 1000, 6));
    expect(q.every((e) => e.lengthSteps === 1)).toBe(true);
  });

  it.each([120, 140])('quantizes analysed audio exactly at %i BPM (±25 ms jitter)', (bpm) => {
    const startSec = 0.37;
    const p = drumPattern({
      sampleRate: SR,
      bpm,
      startSec,
      pattern: 'k-h-s-hhk-hks-h-k-h-s-h-kkh-sh-h',
      jitterMs: 25,
      seed: bpm,
      noiseDb: -60,
    });
    const q = quantizeToGrid(analyzeVoice(p.samples, SR), { bpm, startSec, bars: 2 });
    expect(q.map((e) => e.step)).toEqual(p.steps);
    expect(q.map((e) => e.kind)).toEqual(p.hits.map((h) => expectedKind(h.kind)));
    for (const e of q) expect(Math.abs(e.offsetMs)).toBeLessThanOrEqual(25 + 10);
  });

  it('catches 1/32 hat rolls at resolution 0.5', () => {
    // Steps 0..3 straight, then a 1/32 roll over beat 2 (steps 4–7.5), at 120 BPM.
    const bpm = 120;
    const startSec = 0.25;
    const p = drumPattern({
      sampleRate: SR,
      bpm,
      startSec,
      pattern: 'k-h-hhhhhhhhs---',
      stepsPerBeat: 8,
      noiseDb: -60,
    });
    const events = analyzeVoice(p.samples, SR);
    expect(events.length).toBe(p.hits.length);
    const halfSteps = quantizeToGrid(events, { bpm, startSec }, { resolution: 0.5 });
    expect(halfSteps.map((e) => e.step)).toEqual(p.steps.map((s) => s / 2));
    expect(halfSteps.every((e) => e.lengthSteps >= 0.5 && (e.lengthSteps * 2) % 1 === 0)).toBe(true);
    // At 1/16 the roll collapses onto whole steps, one hat per step.
    const whole = quantizeToGrid(events, { bpm, startSec });
    const hats = whole.filter((e) => e.kind === 'hat').map((e) => e.step);
    expect(new Set(hats).size).toBe(hats.length);
    expect(hats).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops events more than half a step before bar 1, and at or after `bars`', () => {
    const stepSec = 0.125; // 120 BPM
    const q = quantizeToGrid(
      [
        ev(1 - 0.6 * stepSec, 'kick'),
        ev(1 - 0.4 * stepSec, 'hat'),
        ev(1 + 31 * stepSec, 'snare'),
        ev(1 + 32 * stepSec, 'kick'),
      ],
      { bpm: 120, startSec: 1, bars: 2 },
    );
    expect(q.map((e) => [e.step, e.kind])).toEqual([
      [0, 'hat'],
      [31, 'snare'],
    ]);
    expect(q[0]?.offsetMs).toBeCloseTo(-50, 6);
  });

  it('follows swing: odd steps sit later by swing × half a step', () => {
    const stepSec = 0.125;
    const swing = 0.6;
    const events = [0, 1, 2, 3, 5, 6].map((s) => ev(s * stepSec + (s % 2 ? (swing / 2) * stepSec : 0), 'hat'));
    const swung = quantizeToGrid(events, { bpm: 120, startSec: 0 }, { swing });
    expect(swung.map((e) => e.step)).toEqual([0, 1, 2, 3, 5, 6]);
    for (const e of swung) expect(Math.abs(e.offsetMs)).toBeLessThan(1e-6);
    // Without the swing option the same steps come out, but the odd ones read as late.
    const straight = quantizeToGrid(events, { bpm: 120, startSec: 0 });
    expect(straight.map((e) => e.step)).toEqual([0, 1, 2, 3, 5, 6]);
    expect(straight[1]?.offsetMs).toBeCloseTo((swing / 2) * stepSec * 1000, 6);
    // Full swing puts an odd step half a step late: only the swing option can tell.
    const full = quantizeToGrid([ev(1.5 * stepSec, 'hat')], { bpm: 120, startSec: 0 }, { swing: 1 });
    expect(full[0]?.step).toBe(1);
  });

  it('resolves events that land on the same step', () => {
    const q = quantizeToGrid(
      [
        ev(0.0, 'hat', { strength: 0.3 }),
        ev(0.02, 'hat', { strength: 0.6 }),
        ev(0.01, 'kick', { strength: 0.9 }),
        ev(0.25, 'tonal', { duration: 0.03, pitch: 40, pitchEnd: 40, strength: 0.5 }),
        ev(0.29, 'tonal', { duration: 0.33, pitch: 43, pitchEnd: 45, strength: 0.7 }),
      ],
      { bpm: 120, startSec: 0 },
    );
    expect(q.map((e) => [e.step, e.kind])).toEqual([
      [0, 'kick'],
      [0, 'hat'],
      [2, 'tonal'],
    ]);
    expect(q[1]?.strength).toBe(0.6); // the stronger hat
    const note = q[2] as GridEvent;
    expect(note.pitch).toBe(43); // the longer note's pitch
    expect(note.pitchEnd).toBe(45); // ends where the later one ends
    expect(note.time).toBe(0.25);
    expect(note.duration).toBeCloseTo(0.37, 9);
    expect(note.lengthSteps).toBe(3);
    expect(note.strength).toBe(0.7);
  });

  it('gives lengths in grid units that tile legato notes', () => {
    const stepSec = 0.125;
    const notes = [
      ev(0.01, 'tonal', { duration: 3 * stepSec - 0.01 + 0.004, pitch: 36, pitchEnd: 36 }),
      ev(3 * stepSec + 0.004, 'tonal', { duration: 2 * stepSec + 0.02, pitch: 39, pitchEnd: 39 }),
      ev(8 * stepSec, 'hat', { duration: 0.04 }),
    ];
    const q = quantizeToGrid(notes, { bpm: 120, startSec: 0 });
    expect(q.map((e) => [e.step, e.lengthSteps])).toEqual([
      [0, 3],
      [3, 2],
      [8, 1],
    ]);
    const clipped = quantizeToGrid([ev(14 * stepSec, 'tonal', { duration: 6 * stepSec })], {
      bpm: 120,
      startSec: 0,
      bars: 1,
    });
    expect(clipped[0]?.lengthSteps).toBe(2);
  });

  it('honours beatsPerBar and stepsPerBeat', () => {
    // 3/4 in 1/8 steps at 90 BPM: a bar is 6 steps of 1/3 s.
    const q = quantizeToGrid([ev(0, 'kick'), ev(1.0, 'snare'), ev(2.0, 'kick')], {
      bpm: 90,
      startSec: 0,
      bars: 1,
      beatsPerBar: 3,
      stepsPerBeat: 2,
    });
    expect(q.map((e) => e.step)).toEqual([0, 3]);
  });

  it('rejects a bad tempo', () => {
    expect(() => quantizeToGrid([ev(0, 'kick')], { bpm: 0, startSec: 0 })).toThrow(RangeError);
    expect(() => quantizeToGrid([ev(0, 'kick')], { bpm: NaN, startSec: 0 })).toThrow(RangeError);
    expect(quantizeToGrid([], { bpm: 120, startSec: 0 })).toEqual([]);
  });
});

describe('estimateBpm', () => {
  it.each([70, 87, 100, 120, 143, 160, 180])('finds a steady pulse at %i BPM within 2 BPM', (bpm) => {
    const beat = 60 / bpm;
    const events = Array.from({ length: 12 }, (_, i) => ev(0.3 + i * beat, 'kick'));
    expect(Math.abs((estimateBpm(events) as number) - bpm)).toBeLessThanOrEqual(2);
  });

  it('copes with timing jitter and beatbox subdivisions', () => {
    const rand = mulberry32(3);
    for (const bpm of [96, 118, 135]) {
      const s16 = 60 / bpm / 4;
      const jittered = Array.from({ length: 16 }, (_, i) => ev(0.2 + i * 4 * s16 + (rand() * 2 - 1) * 0.01, 'kick'));
      expect(Math.abs((estimateBpm(jittered) as number) - bpm)).toBeLessThanOrEqual(2);
      // "boom ts pf ts" in 8ths with soft hats and some 16ths.
      const pattern = 'k-h-s-h-k-hks-h-k-h-s-h-k-hks-hh';
      const beatbox = [...pattern]
        .map((c, i) =>
          c === '-'
            ? null
            : ev(0.2 + i * s16, c === 'k' ? 'kick' : c === 's' ? 'snare' : 'hat', { strength: c === 'h' ? 0.3 : 0.9 }),
        )
        .filter((e): e is VoiceEvent => e !== null);
      expect(Math.abs((estimateBpm(beatbox) as number) - bpm)).toBeLessThanOrEqual(2);
    }
  });

  it('estimates the tempo of analysed audio', () => {
    const p = drumPattern({
      sampleRate: SR,
      bpm: 128,
      startSec: 0.3,
      pattern: 'k-h-s-h-k-hks-h-k-h-s-h-k-hks-h-',
      jitterMs: 8,
      noiseDb: -60,
    });
    expect(Math.abs((estimateBpm(analyzeVoice(p.samples, SR)) as number) - 128)).toBeLessThanOrEqual(2);
  });

  it('returns null without enough rhythm, and stays in range', () => {
    expect(estimateBpm([])).toBeNull();
    expect(estimateBpm([ev(0, 'kick'), ev(0.5, 'kick')])).toBeNull();
    expect(estimateBpm([ev(1, 'kick'), ev(1, 'hat'), ev(1, 'snare')])).toBeNull();
    const pulse = Array.from({ length: 10 }, (_, i) => ev(i * 0.25, 'kick')); // 240 BPM in quarters
    const bpm = estimateBpm(pulse, { min: 70, max: 180 }) as number;
    expect(bpm).toBeGreaterThanOrEqual(70);
    expect(bpm).toBeLessThanOrEqual(180);
    expect(Math.abs(bpm - 120)).toBeLessThanOrEqual(2); // half time is the in-range reading
    expect(Math.abs((estimateBpm(pulse, { min: 200, max: 260 }) as number) - 240)).toBeLessThanOrEqual(2);
  });
});

describe('describeEvents', () => {
  it('summarizes a groove compactly', () => {
    const events: GridEvent[] = [
      grid(0, 'kick', { strength: 0.94 }),
      grid(2, 'hat', { strength: 0.42 }),
      grid(4, 'snare', { strength: 0.81 }),
      grid(6, 'hat', { strength: 0.38 }),
      grid(8, 'kick', { strength: 1 }),
      grid(10, 'hat', { strength: 0.25, confidence: 0.4 }),
      grid(10.5, 'hat', { strength: 0.2 }),
      grid(12, 'snare', { strength: 0.7 }),
      grid(32, 'tonal', { pitch: 36.2, pitchEnd: 39.1, lengthSteps: 3 }),
      grid(35, 'tonal', { pitch: 39, pitchEnd: 39, lengthSteps: 5 }),
      grid(40, 'tonal', { pitch: null, pitchEnd: null, lengthSteps: 1.5 }),
    ];
    expect(describeEvents(events)).toMatchInlineSnapshot(`
      "11 events (2 kick, 2 snare, 4 hat, 3 tonal), 3 bars of 16 steps, pitch C2–D#2 (MIDI 36–39)
      bar 1: 1 kick(0.9) | 1.3 hat(0.4) | 2 snare(0.8) | 2.3 hat(0.4) | 3 kick(1.0) | 3.3 hat?(0.3) | 3.3+ hat(0.2) | 4 snare(0.7)
      bar 2: -
      bar 3: 1 tonal C2 len 3 slide→D#2 | 1.4 tonal D#2 len 5 | 3 tonal ? len 1.5"
    `);
  });

  it('handles no events, other bar sizes and order', () => {
    expect(describeEvents([])).toBe('0 events');
    const one = describeEvents([grid(7, 'tonal', { pitch: 45.4, pitchEnd: 45.4, lengthSteps: 2 })]);
    expect(one).toBe('1 event (1 tonal), 1 bar of 16 steps, pitch A2 (MIDI 45)\nbar 1: 2.4 tonal A2 len 2');
    // 3/4 with 1/16 steps: 12 steps per bar; input order doesn't matter.
    const waltz = describeEvents([grid(13, 'hat'), grid(12, 'kick'), grid(4, 'snare'), grid(0, 'kick')], {
      stepsPerBar: 12,
    });
    expect(waltz.split('\n').slice(1)).toEqual([
      'bar 1: 1 kick(0.8) | 2 snare(0.8)',
      'bar 2: 1 kick(0.8) | 1.2 hat(0.8)',
    ]);
  });

  it('names notes in scientific pitch and ships a legend for prompts', () => {
    expect([60, 36, 39, 21, 127, 59.6, 23.4].map(noteName)).toEqual(['C4', 'C2', 'D#2', 'A0', 'G9', 'C4', 'B0']);
    expect(VOICE_SUMMARY_LEGEND).toContain('beat.sixteenth');
    expect(VOICE_SUMMARY_LEGEND).toContain('C4 = MIDI 60');
  });
});
