/**
 * Groove through the real engine, offline: the Sampler's velocity tone, swing timing (including
 * humanized notes) and the 808 slide the beat writer sets up.
 */
import { describe, expect, it } from 'vitest';
import sampler from '../../src/plugins/builtin/sampler';
import { highShare } from '../helpers/groove';
import { renderNotes, SR, START } from '../helpers/instruments';

/** Frames of one hit after the music starts. */
const HIT = Math.round(0.4 * SR);

describe('Sampler velocity tone', () => {
  const snare = (velocity: number, velTone: number) =>
    renderNotes(sampler, [{ at: 0, len: 1, key: 60, velocity }], {
      samples: { main: 'kit/snare' },
      params: { velTone },
      tail: 0,
    });

  it('makes a soft hit darker, not just quieter, and leaves full hits alone', async () => {
    const plain = await snare(0.3, 0);
    const toned = await snare(0.3, 0.5);
    const before = highShare(plain, START, START + HIT);
    const after = highShare(toned, START, START + HIT);
    console.log(`velTone: soft snare (vel 0.3) energy above 4 kHz ${before.toFixed(1)}% → ${after.toFixed(1)}% at 50 %`);
    expect(after).toBeLessThanOrEqual(0.75 * before);
    // At full velocity there is no filter: the same samples as without velocity tone.
    const full0 = (await snare(1, 0)).getChannelData(0);
    const full5 = (await snare(1, 0.5)).getChannelData(0);
    expect(full5).toEqual(full0);
  });

  it('plays exactly as before at its default (0)', async () => {
    const withParam = (await snare(0.3, 0)).getChannelData(0);
    const without = (
      await renderNotes(sampler, [{ at: 0, len: 1, key: 60, velocity: 0.3 }], { samples: { main: 'kit/snare' }, tail: 0 })
    ).getChannelData(0);
    expect(withParam).toEqual(without);
  });
});
