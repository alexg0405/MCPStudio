import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../json-values';
import { repairCleanup } from './cleanup';

const samples = { smp_render: {} } as JsonObject;
const good = {
  noise: { amountDb: 12, sensitivity: 0.5, from: 1, to: 1.5 },
  breaths: { reduceDb: 10, sensitivity: 0.5, spans: [{ from: 2, to: 2.4 }] },
  clicks: { sensitivity: 0.5 },
  renderedSampleId: 'smp_render',
  renderedFor: 'n12,0.5,1-1.5',
};

describe('cleanup repair', () => {
  it('leaves a good cleanup alone and says nothing changed', () => {
    const clip = { cleanup: structuredClone(good) } as JsonObject;
    expect(repairCleanup(clip, samples)).toBe(false);
    expect(clip.cleanup).toEqual(good);
  });

  it('forgets a render whose sample is missing, so the clip plays its recording until it is made again', () => {
    const clip = { cleanup: { ...structuredClone(good), renderedSampleId: 'smp_gone' } } as JsonObject;
    expect(repairCleanup(clip, samples)).toBe(true);
    const { renderedSampleId: _s, renderedFor: _f, ...rest } = good;
    expect(clip.cleanup).toEqual(rest);
  });

  it('removes a cleanup that is not an object or does nothing, and reports dropped breath marks', () => {
    const junk = { cleanup: 'loud' } as JsonObject;
    expect(repairCleanup(junk, samples)).toBe(true);
    expect(junk.cleanup).toBeUndefined();
    const nothing = { cleanup: { noise: { amountDb: 0 } } } as JsonObject;
    expect(repairCleanup(nothing, samples)).toBe(true);
    expect(nothing.cleanup).toBeUndefined();
    const marks = { cleanup: { breaths: { reduceDb: 6, spans: [{ from: 3, to: 2 }, { from: 1, to: 2 }] } } } as JsonObject;
    expect(repairCleanup(marks, samples)).toBe(true);
    expect((marks.cleanup as JsonObject).breaths).toEqual({ reduceDb: 6, sensitivity: 0.5, spans: [{ from: 1, to: 2 }] });
  });
});
