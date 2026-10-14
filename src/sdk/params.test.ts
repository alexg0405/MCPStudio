import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  descriptors,
  formatValue,
  fromNormalized,
  messageParamNames,
  p,
  resolveValues,
  sanitize,
  toNormalized,
  type ParamSpec,
} from './params';

describe('params', () => {
  const specs = {
    cutoff: p.float(20, 20000, 1000, { scale: 'log', unit: 'Hz' }),
    level: p.float(-60, 6, -6, { scale: 'db', unit: 'dB' }),
    voices: p.int(1, 16, 8),
    wave: p.enum(['sine', 'saw', 'square'], 'saw'),
    on: p.bool(true),
  };

  it('round-trips through normalized knob travel', () => {
    const all = Object.values(specs) as ParamSpec[];
    for (const spec of all) {
      fc.assert(
        fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (n) => {
          const v = fromNormalized(spec, n);
          const back = fromNormalized(spec, toNormalized(spec, v));
          if (typeof v === 'number') expect(back as number).toBeCloseTo(v, 6);
          else expect(back).toBe(v);
        }),
      );
    }
  });

  it('maps log scale geometrically', () => {
    expect(toNormalized(specs.cutoff, 20)).toBe(0);
    expect(toNormalized(specs.cutoff, 20000)).toBeCloseTo(1);
    expect(fromNormalized(specs.cutoff, 0.5) as number).toBeCloseTo(Math.sqrt(20 * 20000), 6);
  });

  it('sanitizes stored values and fills defaults', () => {
    expect(sanitize(specs.cutoff, 1e9)).toBe(20000);
    expect(sanitize(specs.voices, 3.6)).toBe(4);
    expect(sanitize(specs.wave, 'triangle')).toBe('saw');
    expect(sanitize(specs.on, 'yes')).toBe(true);
    expect(resolveValues(specs, { cutoff: 500 })).toEqual({ cutoff: 500, level: -6, voices: 8, wave: 'saw', on: true });
  });

  it('builds AudioParam descriptors for the params automation can drive; the rest travel as events', () => {
    const d = descriptors(specs);
    expect(d.find((x) => x.name === 'cutoff')).toMatchObject({ automationRate: 'a-rate', minValue: 20 });
    expect(d.find((x) => x.name === 'voices')).toMatchObject({ automationRate: 'k-rate' });
    expect(d.map((x) => x.name)).not.toContain('wave');
    expect(messageParamNames(specs)).toEqual(['wave', 'on']);
    // An enum that opts in to automation is an AudioParam (k-rate, by option index).
    const opted = descriptors({ wave: p.enum(['a', 'b', 'c'] as const, 'b', { automatable: true }) });
    expect(opted[0]).toMatchObject({ name: 'wave', automationRate: 'k-rate', defaultValue: 1, maxValue: 2 });
  });

  it('formats values with units', () => {
    expect(formatValue(specs.cutoff, 1200)).toBe('1.20 kHz');
    expect(formatValue(specs.cutoff, 440)).toBe('440 Hz');
    expect(formatValue(specs.level, -60)).toBe('-∞ dB');
    expect(formatValue(specs.level, 3)).toBe('+3.0 dB');
    expect(formatValue(p.float(0, 1, 0.5, { unit: '%' }), 0.5)).toBe('50%');
    expect(formatValue(specs.on, false)).toBe('Off');
  });
});
