import { describe, expect, it } from 'vitest';
import type { Style } from '../beat/style';
import { BAR, BEAT } from '../../../test/helpers/arrange';
import { FILL_ROTATION, phraseEvents, type PhraseEvent, type PhraseInput } from './phrases';

const all = { drums: true, hats: true, openHat: true, slide: true };
const input = (patch: Partial<PhraseInput> = {}): PhraseInput => ({
  bars: 16,
  barTicks: BAR,
  energy: 4,
  style: 'trap',
  vary: 'auto',
  fill: 'auto',
  caps: all,
  loopBars: 2,
  index: 0,
  ...patch,
});
const lastBarFill: PhraseEvent[] = [{ kind: 'snare-fill', from: 16 * BAR - 2 * BEAT, to: 16 * BAR, energy: 4, why: 'end' }];
const at = (events: PhraseEvent[]) => events.map((e) => [e.kind, Math.round((e.to / BAR) * 100) / 100]);

/** Runs of identical 2-bar clips, as their bar counts. */
function runs(events: PhraseEvent[], bars: number, loop: number): number[] {
  const sig = (k: number) =>
    events
      .filter((e) => e.from < (k + 1) * loop * BAR && e.to > k * loop * BAR)
      .map((e) => `${e.kind}${e.from - k * loop * BAR}`)
      .sort()
      .join();
  const out: number[] = [];
  let run = 1;
  for (let k = 1; k < bars / loop; k++) {
    if (sig(k) === sig(k - 1)) run++;
    else {
      out.push(run * loop);
      run = 1;
    }
  }
  out.push(run * loop);
  return out;
}

describe('phrase rules', () => {
  it('trap: a fill every 8 bars, a small change every 4, a crash after the fill, double hats in bars 9–16', () => {
    const { events, crashes } = phraseEvents(input(), lastBarFill, { fill: 0 });
    expect(at(events)).toEqual([
      ['double-hats', 16],
      ['hat-roll', 4],
      ['snare-fill', 8],
      ['slide', 12],
      ['snare-fill', 16],
    ]);
    const fill = events.find((e) => e.why === 'phrase')!;
    expect(fill.to - fill.from).toBe(2 * BEAT);
    expect(crashes).toEqual([8 * BAR]);
  });

  it('fills are 1 beat below energy 3; house waits 16 bars for a fill and 8 for a change', () => {
    const quiet = phraseEvents(input({ energy: 2 }), [], { fill: 0 }).events.find((e) => e.why === 'phrase')!;
    expect(quiet.to - quiet.from).toBe(BEAT);
    const house = phraseEvents(input({ style: 'house', loopBars: 4, energy: 3 }), lastBarFill, { fill: 0 }).events;
    expect(at(house)).toEqual([
      ['open-hat', 8],
      ['snare-fill', 16],
    ]);
  });

  it('never lets a 2-bar loop repeat more than once in a row (house adds changes at bars 4 and 12)', () => {
    for (const style of ['house', 'edm', 'trap', 'boombap'] as Style[]) {
      const { events } = phraseEvents(input({ style, energy: 3 }), lastBarFill, { fill: 0 });
      expect(Math.max(...runs(events, 16, 2))).toBeLessThanOrEqual(4);
    }
    const house = phraseEvents(input({ style: 'house', energy: 3 }), lastBarFill, { fill: 0 }).events;
    expect(house.filter((e) => e.why === 'small').map((e) => e.to / BAR)).toEqual([4, 8, 12]);
    // A 1-bar loop may play 4 times, never more.
    const one = phraseEvents(input({ style: 'house', energy: 3, loopBars: 1 }), lastBarFill, { fill: 0 }).events;
    expect(Math.max(...runs(one, 16, 1))).toBeLessThanOrEqual(4);
  });

  it('vary: none adds nothing, less only fills, more a change every 2 bars', () => {
    expect(phraseEvents(input({ vary: 'none', energy: 3 }), lastBarFill, { fill: 0 }).events).toEqual(lastBarFill);
    const less = phraseEvents(input({ vary: 'less', energy: 3, loopBars: 4 }), lastBarFill, { fill: 0 }).events;
    expect(less.filter((e) => e.why !== 'end').map((e) => e.kind)).toEqual(['snare-fill']);
    const more = phraseEvents(input({ vary: 'more', energy: 3 }), lastBarFill, { fill: 0 }).events;
    expect(more.filter((e) => e.why === 'small').map((e) => e.to / BAR)).toEqual([2, 4, 6, 10, 12, 14]);
  });

  it('uses what the patterns can play: no hats means slides, no 808 means rolls, neither means short fills', () => {
    const slides = phraseEvents(input({ caps: { ...all, hats: false, openHat: false } }), lastBarFill, { fill: 0 }).events;
    expect(slides.filter((e) => e.why === 'small').map((e) => e.kind)).toEqual(['slide', 'slide']);
    const bare = phraseEvents(input({ caps: { drums: true, hats: false, openHat: false, slide: false } }), lastBarFill, { fill: 0 }).events;
    expect(bare.filter((e) => e.why === 'small').map((e) => [e.kind, e.to - e.from])).toEqual([
      ['snare-fill', BEAT],
      ['snare-fill', BEAT],
    ]);
    // Music only: the transitions are all there is.
    expect(phraseEvents(input({ caps: { drums: false, hats: false, openHat: false, slide: false } }), [], { fill: 0 }).events).toEqual([]);
  });

  it('keeps the bars the transition uses (a 4-bar snare build) free of phrase changes', () => {
    const build: PhraseEvent[] = [{ kind: 'snare-build', from: 4 * BAR, to: 8 * BAR - BEAT, energy: 3, why: 'end' }];
    const { events } = phraseEvents(input({ bars: 8, energy: 3 }), build, { fill: 0 });
    expect(events.filter((e) => e.why !== 'end').every((e) => e.to <= 4 * BAR)).toBe(true);
  });

  it('rotates the fills of each style', () => {
    expect(FILL_ROTATION.trap).toContain('hat-fill');
    expect(FILL_ROTATION.house).toContain('tom-fill');
    const rotation = { fill: 0 };
    const kinds = [0, 1, 2].map(() => phraseEvents(input({ bars: 8, energy: 3 }), [], rotation).events.find((e) => e.why === 'phrase')!.kind);
    expect(kinds).toEqual(['snare-fill', 'hat-fill', 'snare-fill']);
  });
});
