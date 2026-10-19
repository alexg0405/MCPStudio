import { describe, expect, it } from 'vitest';
import type { SampleId, VocalCleanup } from '../model/types';

const SAMPLE = 'smp_s' as SampleId;
import {
  activeBreaths,
  applyCleanupRequest,
  BREATH_REMOVE_DB,
  cleanupSignature,
  describeCleanup,
  isNeutralCleanup,
  isRenderCurrent,
  sanitizeCleanup,
} from './cleanup-edit';

const full: VocalCleanup = {
  noise: { amountDb: 12, sensitivity: 0.5, from: 1, to: 1.5 },
  breaths: { reduceDb: 10, sensitivity: 0.5, spans: [{ from: 2, to: 2.4 }, { from: 5, to: 5.3, off: true }] },
  clicks: { sensitivity: 0.5 },
};

describe('cleanup settings', () => {
  it('is neutral only when no section does anything', () => {
    expect(isNeutralCleanup({})).toBe(true);
    expect(isNeutralCleanup({ noise: { amountDb: 0, sensitivity: 0.5 } })).toBe(true);
    expect(isNeutralCleanup({ breaths: { reduceDb: 0, sensitivity: 0.5 } })).toBe(true);
    expect(isNeutralCleanup({ clicks: { sensitivity: 0.5 } })).toBe(false);
    expect(isNeutralCleanup(full)).toBe(false);
  });

  it('has a signature that changes with every setting that changes the sound, and with nothing else', () => {
    const base = cleanupSignature(full);
    expect(cleanupSignature({ ...full, renderedSampleId: SAMPLE, renderedFor: base })).toBe(base);
    const changed: VocalCleanup[] = [
      { ...full, noise: { ...full.noise!, amountDb: 15 } },
      { ...full, noise: { ...full.noise!, sensitivity: 0.7 } },
      { ...full, noise: { ...full.noise!, from: 2 } },
      { ...full, breaths: { ...full.breaths!, reduceDb: 20 } },
      { ...full, breaths: { ...full.breaths!, spans: [{ from: 2, to: 2.5 }] } },
      { ...full, breaths: { ...full.breaths!, spans: [{ from: 2, to: 2.4 }, { from: 5, to: 5.3 }] } },
      { ...full, clicks: { sensitivity: 0.9 } },
      { noise: full.noise!, breaths: full.breaths! },
    ];
    for (const c of changed) expect(cleanupSignature(c)).not.toBe(base);
    // A switched-off marker is ignored while it stays off, and the breath findings missing read as "find".
    expect(cleanupSignature({ ...full, breaths: { ...full.breaths!, spans: [{ from: 2, to: 2.4 }, { from: 9, to: 9.2, off: true }] } })).toBe(base);
    expect(cleanupSignature({ breaths: { reduceDb: 10, sensitivity: 0.5 } })).toContain('find');
  });

  it('knows a render is current only for the settings it was made from', () => {
    const sig = cleanupSignature(full);
    expect(isRenderCurrent({ ...full, renderedSampleId: SAMPLE, renderedFor: sig })).toBe(true);
    expect(isRenderCurrent({ ...full, renderedSampleId: SAMPLE, renderedFor: 'old' })).toBe(false);
    expect(isRenderCurrent(full)).toBe(false);
  });

  it('lists the breaths that will be lowered', () => {
    expect(activeBreaths(full)).toEqual([{ from: 2, to: 2.4 }]);
    expect(activeBreaths({})).toEqual([]);
  });

  describe('a request (the AI and the window)', () => {
    it('switches sections on with their defaults and off with 0', () => {
      const on = applyCleanupRequest(undefined, { noiseDb: 14, breathsDb: 8, clicks: true });
      expect(on).toEqual({ noise: { amountDb: 14, sensitivity: 0.5 }, breaths: { reduceDb: 8, sensitivity: 0.5 }, clicks: { sensitivity: 0.5 } });
      const off = applyCleanupRequest(on, { noiseDb: 0, breathsDb: 0, clicks: false });
      expect(off).toEqual({});
    });

    it('leaves sections it is not asked about as they are, keeps the learned stretch and the render', () => {
      const before: VocalCleanup = { ...full, renderedSampleId: SAMPLE, renderedFor: 'sig' };
      const next = applyCleanupRequest(before, { noiseDb: 6 });
      expect(next.noise).toEqual({ amountDb: 6, sensitivity: 0.5, from: 1, to: 1.5 });
      expect(next.breaths).toEqual(before.breaths);
      expect(next.clicks).toEqual(before.clicks);
      expect(next.renderedSampleId).toBe(SAMPLE);
      expect(next.renderedFor).toBe('sig');
    });

    it('forgets the breaths found when their sensitivity changes (they are found again), keeps them for a new amount', () => {
      expect(applyCleanupRequest(full, { breathsDb: 20 }).breaths!.spans).toEqual(full.breaths!.spans);
      expect(applyCleanupRequest(full, { breathSensitivity: 80 }).breaths!.spans).toBeUndefined();
      expect(applyCleanupRequest(full, { breathSensitivity: 80 }).breaths!.sensitivity).toBeCloseTo(0.8);
    });

    it('clamps to the ranges: noise to 30 dB, breaths to the remove setting, sensitivities to 0–100 %', () => {
      const next = applyCleanupRequest(undefined, { noiseDb: 99, noiseSensitivity: 250, breathsDb: 999, breathSensitivity: -5, clicks: true, clickSensitivity: 400 });
      expect(next.noise).toEqual({ amountDb: 30, sensitivity: 1 });
      expect(next.breaths).toEqual({ reduceDb: BREATH_REMOVE_DB, sensitivity: 0 });
      expect(next.clicks).toEqual({ sensitivity: 1 });
    });
  });

  describe('repair of stored settings', () => {
    it('keeps good settings as they are', () => {
      expect(sanitizeCleanup({ ...full, renderedSampleId: SAMPLE, renderedFor: 'x' })).toEqual({ ...full, renderedSampleId: SAMPLE, renderedFor: 'x' });
    });

    it('fixes ranges, drops sections that do nothing or are not objects, sorts spans and drops overlapping or backwards ones', () => {
      const fixed = sanitizeCleanup({
        noise: { amountDb: 80, sensitivity: -1, from: 5, to: 4 },
        breaths: { reduceDb: 5, spans: [{ from: 3, to: 3.5 }, { from: 1, to: 2 }, { from: 1.5, to: 2.5 }, { from: 4, to: 3 }, 'x', { from: 'a', to: 1 }] },
        clicks: 'yes',
        renderedSampleId: 7,
      });
      expect(fixed).toEqual({
        noise: { amountDb: 30, sensitivity: 0 },
        breaths: { reduceDb: 5, sensitivity: 0.5, spans: [{ from: 1, to: 2 }, { from: 3, to: 3.5 }] },
      });
      expect(sanitizeCleanup({ noise: { amountDb: 0 } })).toBeNull();
      expect(sanitizeCleanup('nothing')).toBeNull();
      expect(sanitizeCleanup([])).toBeNull();
      expect(sanitizeCleanup(null)).toBeNull();
    });
  });

  it('describes itself in plain words', () => {
    expect(describeCleanup(full)).toBe('noise down 12 dB, breaths down 10 dB (1 found), mouth clicks removed');
    expect(describeCleanup({ breaths: { reduceDb: BREATH_REMOVE_DB, sensitivity: 0.5 } })).toBe('breaths removed');
    expect(describeCleanup({})).toBe('nothing is changed');
  });
});
