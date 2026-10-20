import { describe, expect, it } from 'vitest';
import {
  applyDeadZone,
  fadeEdges,
  limitSpeed,
  MAX_SPEED,
  MIN_SPEED,
  protectAttacks,
  smoothLag,
  tightnessSettings,
} from './lag';

const HOP = 0.005;

describe('tightness', () => {
  it('gets tighter as it goes up: less smoothing, a smaller dead zone, a smaller step penalty', () => {
    const settings = [0, 25, 50, 75, 100].map(tightnessSettings);
    for (let i = 1; i < settings.length; i++) {
      expect(settings[i]!.smoothSec).toBeLessThan(settings[i - 1]!.smoothSec);
      expect(settings[i]!.stepPenalty).toBeLessThan(settings[i - 1]!.stepPenalty);
      expect(settings[i]!.deadZoneSec).toBeLessThanOrEqual(settings[i - 1]!.deadZoneSec);
    }
    expect(tightnessSettings(100).deadZoneSec).toBe(0);
    expect(tightnessSettings(0).deadZoneSec).toBeGreaterThan(0.05);
    // Out-of-range values are clamped.
    expect(tightnessSettings(250)).toEqual(tightnessSettings(100));
    expect(tightnessSettings(-4)).toEqual(tightnessSettings(0));
  });
});

describe('smoothing and the dead zone', () => {
  it('takes the lag of the sound next to a silence, not the path’s guess inside it', () => {
    const lag = new Float32Array(200);
    const weight = new Float32Array(200).fill(0.03);
    lag.fill(0.05, 0, 80);
    weight.fill(1, 0, 80);
    lag.fill(-0.2, 80, 120); // a silent stretch where the path wandered
    lag.fill(0.05, 120, 200);
    weight.fill(1, 120, 200);
    const smooth = smoothLag(lag, weight, 0.8, HOP);
    for (let i = 60; i < 140; i++) expect(Math.abs((smooth[i] as number) - 0.05)).toBeLessThan(0.04);
  });

  it('removes small offsets and shortens big ones by the dead zone', () => {
    const out = applyDeadZone(Float32Array.from([0.02, -0.03, 0.1, -0.2]), 0.06);
    expect(Array.from(out).map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 0, 0.04, -0.14]);
  });
});

describe('limitSpeed', () => {
  const steps = (lag: Float32Array) => Array.from(lag.subarray(1), (v, i) => (v - (lag[i] as number)) / HOP);

  it('keeps the speed within half and double where the clip sounds', () => {
    const lag = Float32Array.from({ length: 300 }, (_, i) => (i > 100 ? -0.2 : 0.1));
    const sound = new Float32Array(300).fill(1);
    const out = limitSpeed(lag, HOP, sound);
    for (const s of steps(out)) {
      expect(1 + s).toBeGreaterThanOrEqual(MIN_SPEED - 1e-6);
      expect(1 + s).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
    }
  });

  it('lets a silence take up the time of a big change', () => {
    const lag = Float32Array.from({ length: 300 }, (_, i) => (i > 150 ? -0.2 : 0.1));
    const sound = Float32Array.from({ length: 300 }, (_, i) => (i > 130 && i < 170 ? 0 : 1));
    const out = limitSpeed(lag, HOP, sound);
    // Faster than the sounding limit allows, and only inside the silence.
    expect(Math.min(...steps(out))).toBeLessThan(MIN_SPEED - 1 - 0.1);
    const fast = steps(out).map((s, i) => (1 + s < MIN_SPEED - 1e-6 ? i + 1 : -1)).filter((i) => i >= 0);
    for (const i of fast) expect(sound[i]).toBe(0);
  });

  it('keeps pinned values exactly and makes the speed change before them', () => {
    const lag = new Float32Array(400);
    for (let i = 0; i < 400; i++) lag[i] = i < 200 ? 0.08 : -0.06;
    const pins = [
      { fromFrame: 150, toFrame: 160, value: 0.08 },
      { fromFrame: 330, toFrame: 345, value: -0.06 },
    ];
    const sound = new Float32Array(400).fill(1);
    const out = limitSpeed(lag, HOP, sound, pins);
    for (let i = 150; i <= 160; i++) expect(out[i]).toBeCloseTo(0.08, 5);
    for (let i = 330; i <= 345; i++) expect(out[i]).toBeCloseTo(-0.06, 5);
    for (const s of steps(out)) {
      expect(1 + s).toBeGreaterThanOrEqual(MIN_SPEED - 1e-4);
      expect(1 + s).toBeLessThanOrEqual(MAX_SPEED + 1e-4);
    }
  });

  it('moves a pin the least it must when it cannot be reached', () => {
    const lag = new Float32Array(100).fill(0);
    const pins = [
      { fromFrame: 10, toFrame: 12, value: 0.1 },
      { fromFrame: 30, toFrame: 32, value: -0.5 },
    ];
    const out = limitSpeed(lag, HOP, new Float32Array(100).fill(1), pins);
    // The 18 frames between the pins at half speed allow at most 0.5 × 18 × 5 ms = 45 ms of change: the second pin stops short of −0.5.
    expect(out[31]).toBeGreaterThan(-0.5);
    expect(out[31]).toBeCloseTo(0.1 - 0.045, 3);
    expect(out[11]).toBeCloseTo(0.1, 5);
  });
});

describe('protectAttacks and fadeEdges', () => {
  it('makes the lag flat across an attack and reports where', () => {
    const lag = Float32Array.from({ length: 400 }, (_, i) => 0.05 - i * 0.0001);
    const matched = Float32Array.from({ length: 400 }, (_, i) => i + lag[i]! / HOP);
    const { lag: out, kept, pins } = protectAttacks(lag, matched, [{ sec: 1 }], HOP);
    expect(kept).toHaveLength(1);
    expect(pins).toHaveLength(1);
    const from = pins[0]!.fromFrame;
    const to = pins[0]!.toFrame;
    for (let i = from; i <= to; i++) expect(out[i]).toBeCloseTo(pins[0]!.value, 6);
    // Away from the attack nothing changed.
    expect(out[10]).toBe(lag[10]);
    expect(out[390]).toBe(lag[390]);
  });

  it('skips an attack that is too close to the one before', () => {
    const lag = new Float32Array(400);
    const matched = Float32Array.from({ length: 400 }, (_, i) => i);
    const { kept } = protectAttacks(lag, matched, [{ sec: 1 }, { sec: 1.05 }, { sec: 1.6 }], HOP);
    expect(kept).toHaveLength(2);
  });

  it('fades the move to nothing at the ends of the stretch when the clip starts well inside it', () => {
    const lag = new Float32Array(400).fill(0.1);
    const out = fadeEdges(lag, HOP, { fromSec: 0.5, toSec: 1.5 });
    expect(out[0]).toBe(0);
    expect(out[399]).toBeCloseTo(0, 6);
    expect(out[200]).toBeCloseTo(0.1, 6);
    // A clip that starts at the very start has nothing to fade there.
    expect(fadeEdges(lag, HOP, { fromSec: 0, toSec: 1.5 })[0]).toBeCloseTo(0.1, 6);
  });
});
