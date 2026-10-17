import { describe, expect, it } from 'vitest';
import { Rng } from '@agstudio/sdk/dsp/random';
import { PluckKernel } from '../../src/plugins/builtin/pluck/kernel';
import { pluckParams } from '../../src/plugins/builtin/pluck/params';
import { cpuNow, perfLimit, settle } from '../helpers/perf';

const SR = 48000;

type Voices = { pool: { voices: { shape: boolean }[] } };

describe('Pluck note-on cost', () => {
  it('normalising eight low notes that start in one block costs at most 0.25 ms', { tags: ['perf'], timeout: 120_000 }, async () => {
    // A 128-frame block at 48 kHz is 2.67 ms of audio-thread time, and a strummed chord starts several
    // notes in one block. The bursts of low notes are the longest, so that is the worst case. The
    // regular run shares its cores with the whole suite and only keeps a loose bound.
    const limit = perfLimit(0.25, 1);
    const keys = [24, 25, 26, 27, 28, 29, 30, 31];
    const reps = 100;
    const params: Record<string, Float32Array> = {};
    for (const [name, spec] of Object.entries(pluckParams)) params[name] = new Float32Array([spec.default]);
    // Average ms per block of the eight notes' first render, with the normalisation on or off.
    const blockMs = (shaped: boolean): number => {
      let total = 0;
      for (let r = 0; r < reps; r++) {
        const rng = new Rng(r + 1);
        const k = new PluckKernel({ sampleRate: SR, state: undefined, post: () => {}, rand: () => rng.next() });
        keys.forEach((key, j) => k.noteOn(key, 1, j + 1, 0));
        if (!shaped) for (const v of (k as unknown as Voices).pool.voices) v.shape = false;
        const L = new Float32Array(128);
        const R = new Float32Array(128);
        const t0 = cpuNow();
        k.render([L, R], 0, 128, params as never);
        total += cpuNow() - t0;
      }
      return total / reps;
    };
    // The normalisation's share of the block, best of a few attempts (interference only adds time).
    const best = await settle(() => blockMs(true) - blockMs(false), (b) => b <= limit);
    expect(best).toBeLessThanOrEqual(limit);
  });
});
