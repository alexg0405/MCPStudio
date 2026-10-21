/** Running a whole chain: order, bypass, unknown effects, and that the span asked for does not change what comes out. */
import { describe, expect, it } from 'vitest';
import type { MidiFxSlot } from '../model/types';
import { PPQ } from '../time/ppq';
import { activeEffects, chainReach } from './chain';
import { keysOf, noteAt, runSlots, slotOf, stepsOf, STEP, testContext } from './test-support';

const C = 60;
const chordHeldOneBar = [noteAt('c', 0, 16, 60), noteAt('e', 0, 16, 64), noteAt('g', 0, 16, 67)];

describe('a chain of effects', () => {
  it('passes notes through unchanged with no effects', () => {
    const notes = [noteAt('a', 0, 1, C), noteAt('b', 4, 1, 64)];
    expect(runSlots([], notes)).toEqual(notes);
  });

  it('runs the effects in order: a chord then an arpeggiator arpeggiates the chord', () => {
    const chordThenArp = runSlots([slotOf('chord', { shape: 'maj' }), slotOf('arp', { pattern: 'up' })], [noteAt('n', 0, 8, C)], { from: 0, to: 4 * STEP });
    expect(keysOf(chordThenArp)).toEqual([60, 64, 67, 60]);
    // The other way round, every arpeggio step becomes a chord.
    const arpThenChord = runSlots([slotOf('arp', { pattern: 'up' }), slotOf('chord', { shape: 'maj' })], [noteAt('n', 0, 8, C)], { from: 0, to: 2 * STEP });
    expect(keysOf(arpThenChord)).toEqual([60, 64, 67, 60, 64, 67]);
    expect(stepsOf(arpThenChord)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('a bypassed effect does nothing, and so does one this version does not know', () => {
    const notes = [noteAt('a', 0, 1, C)];
    const bypassed: MidiFxSlot = { ...slotOf('transpose', { semitones: 5 }), enabled: false };
    const unknown = slotOf('from-the-future', { x: 1 });
    expect(runSlots([bypassed, unknown], notes)).toEqual(notes);
    expect(activeEffects([bypassed, unknown])).toHaveLength(0);
  });

  it('reports how far the chain can move notes', () => {
    const reach = chainReach(activeEffects([slotOf('arp', { rate: '1/8' }), slotOf('echo', { delay: '1/4', repeats: 2 })]));
    expect(reach.after).toBeGreaterThanOrEqual(2 * 480 + 16 * 960);
    expect(reach.before).toBe(0);
  });

  it('gives the same notes whichever stretch is asked for (arpeggio, echo and humanize together)', () => {
    const slots = [slotOf('arp', { pattern: 'upDown', rate: '1/16', octaves: 2, swing: 0.3 }), slotOf('echo', { delay: '1/8', repeats: 3 }), slotOf('humanize', { timing: 15, seed: 7 })];
    const whole = runSlots(slots, chordHeldOneBar, { from: 0, to: 3 * PPQ });
    const edges = [0, 100, 777, 1500, 1501, 2222, 3 * PPQ];
    const pieces = edges.slice(1).flatMap((to, i) => runSlots(slots, chordHeldOneBar, { from: edges[i]!, to }));
    const describeNote = (n: { id: string; start: number; end: number; key: number; velocity: number }) => [n.id, +n.start.toFixed(6), +n.end.toFixed(6), n.key, +n.velocity.toFixed(6)];
    expect(pieces.map(describeNote)).toEqual(whole.map(describeNote));
  });

  it('is the same when run twice (a chain has no hidden state)', () => {
    const slots = [slotOf('random', { chance: 0.6, jump: 0.5, seed: 9 }), slotOf('humanize', { seed: 4 })];
    const part = Array.from({ length: 16 }, (_, i) => noteAt(`n${i}`, i, 1, C + i));
    expect(runSlots(slots, part)).toEqual(runSlots(slots, part));
  });

  it('reads a knob from an automation clip where one drives it', () => {
    const slots = [slotOf('transpose', {}, 'mfx_t')];
    const context = { ...testContext(), automated: (slotId: string, param: string, tick: number) => (slotId === 'mfx_t' && param === 'semitones' ? (tick < 4 * STEP ? 0 : 12) : undefined) };
    const out = runSlots(slots, [noteAt('a', 0, 1, C), noteAt('b', 8, 1, C)], undefined, context);
    expect(keysOf(out)).toEqual([60, 72]);
  });
});
