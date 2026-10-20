import { describe, expect, it } from 'vitest';
import { BEATS, drumLoop, TRANSCRIBE_RATE } from '../../../../test/helpers/transcribe-signals';
import { butterworth, filterInPlace } from '../../voice/filters';
import { detectDrums } from './drums';
import { cleanCuts, type PadCut } from './kit-clean';
import { planTranscription } from './plan';
import { settingsFor } from './types';
import { timelineOf } from '../../../../test/helpers/transcribe-signals';
import { listen } from './listen';

const SR = TRANSCRIBE_RATE;

/** The energy under 100 Hz of a cut: where a kick lives and a clap does not. */
function lowEnergy(channels: Float32Array[]): number {
  const low = Float32Array.from(channels[0] as Float32Array);
  filterInPlace(low, butterworth('lowpass', 4, 100, SR));
  let sum = 0;
  for (const v of low) sum += v * v;
  return sum;
}

describe('pad examples without the drums that always sound with them', () => {
  // In this loop every clap is on a kick, so the best example of the clap still has the kick in it.
  const loop = drumLoop({ bpm: 120, bars: 2, patterns: [BEATS.house ?? []] });
  const heard = detectDrums(loop.mono, SR);
  const cutOf = (kind: string) => heard.cuts.find((c) => c.kind === kind);

  it('knows which examples have another drum under them', () => {
    expect(cutOf('clap')?.with?.map((w) => w.kind)).toEqual(['kick']);
    expect(cutOf('kick')?.with).toBeUndefined();
  });

  it('takes the kick out of the clap: its energy under 100 Hz falls by 15 dB or more, and the kick itself is untouched', () => {
    const slice = (from: number, to: number) => [loop.mono.slice(Math.round(from * SR), Math.round(to * SR))];
    const cuts: PadCut[] = heard.cuts
      .filter((c) => c.kind === 'kick' || c.kind === 'clap')
      .map((c) => ({ kind: c.kind, ...(c.with ? { with: c.with } : {}), channels: slice(c.fromSec, c.toSec) }));
    const cleaned = cleanCuts(cuts, SR);
    const clapAt = cuts.findIndex((c) => c.kind === 'clap');
    const kickAt = cuts.findIndex((c) => c.kind === 'kick');
    const drop = 10 * Math.log10(lowEnergy(cuts[clapAt]!.channels) / lowEnergy(cleaned[clapAt]!));
    expect(drop).toBeGreaterThanOrEqual(15);
    expect(cleaned[kickAt]).toBe(cuts[kickAt]!.channels);
  });

  it('is part of the plan: the clap pad says it has a kick in it', () => {
    const plan = planTranscription(listen('drums', loop.mono, SR), timelineOf({ bpm: 120 }), settingsFor('drums'));
    const clap = plan.pads.find((p) => p.kind === 'clap');
    expect(clap?.pad).toBe(4);
    expect(clap?.with?.[0]?.kind).toBe('kick');
  });
});
