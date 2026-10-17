import { describe, expect, it } from 'vitest';
import { constantTempo } from '../time/ppq';
import {
  normalizeSegments,
  planComp,
  readComp,
  stepTake,
  swipeSegments,
  takeAt,
  wholeTake,
  type CompSpan,
} from './comp';

const tempo = constantTempo(120); // 1920 ticks per second
const TPS = 1920;

/** Three takes of one 8 s recording, one clip each over ticks 0–15360, their sample trims all equal (shared sample). */
const span = (index: number, start = 0, length = 15360): CompSpan => ({
  index,
  ref: `clip${index}`,
  start,
  length,
  // A shared recording: tick t is t / TPS seconds into it.
  offsetAt: (t) => t / TPS,
});
const spans = [span(0), span(1), span(2)];

describe('comp segments', () => {
  it('a swipe replaces what played there and keeps the rest', () => {
    const base = wholeTake(spans, 2);
    expect(base).toEqual([{ take: 2, from: 0, to: 15360 }]);
    const out = swipeSegments(base, spans, 0, 3840, 7680);
    expect(out).toEqual([
      { take: 2, from: 0, to: 3840 },
      { take: 0, from: 3840, to: 7680 },
      { take: 2, from: 7680, to: 15360 },
    ]);
    // Swiping the same take back over its neighbours joins them again.
    expect(swipeSegments(out, spans, 2, 3840, 7680)).toEqual([{ take: 2, from: 0, to: 15360 }]);
  });

  it('a swipe is cut to where the take has audio and ignores a backwards drag', () => {
    const short = [span(0), span(1, 1920, 1920)];
    const out = swipeSegments(wholeTake(short, 0), short, 1, 0, 9600);
    expect(out).toEqual([
      { take: 0, from: 0, to: 1920 },
      { take: 1, from: 1920, to: 3840 },
      { take: 0, from: 3840, to: 15360 },
    ]);
    expect(swipeSegments(wholeTake(short, 0), short, 1, 3600, 1920)).toEqual(swipeSegments(wholeTake(short, 0), short, 1, 1920, 3600));
    // A take with no audio there changes nothing.
    expect(swipeSegments(wholeTake(short, 0), short, 1, 8000, 9000)).toEqual(wholeTake(short, 0));
  });

  it('next and previous take go round among the takes that have audio in the range', () => {
    const comp = wholeTake(spans, 1);
    expect(stepTake(comp, spans, 0, 3840, 1)).toBe(2);
    expect(stepTake(comp, spans, 0, 3840, -1)).toBe(0);
    expect(stepTake(wholeTake(spans, 2), spans, 0, 3840, 1)).toBe(0);
    expect(stepTake(wholeTake(spans, 0), spans, 0, 3840, -1)).toBe(2);
    // Only one take there: nothing to step to.
    expect(stepTake(wholeTake([span(0)], 0), [span(0)], 0, 3840, 1)).toBeNull();
    // Takes without audio in the range are skipped.
    const late = [span(0), span(1, 9600, 1920), span(2)];
    expect(stepTake(wholeTake(late, 0), late, 0, 3840, 1)).toBe(2);
    expect(takeAt([{ take: 1, from: 0, to: 100 }, { take: 2, from: 100, to: 1000 }], 0, 1000)).toBe(2);
  });

  it('normalizes: sorted, no empties, touching segments of one take joined', () => {
    expect(
      normalizeSegments([
        { take: 1, from: 100, to: 200 },
        { take: 1, from: 0, to: 100 },
        { take: 0, from: 300, to: 300 },
        { take: 2, from: 200, to: 400 },
      ]),
    ).toEqual([
      { take: 1, from: 0, to: 200 },
      { take: 2, from: 200, to: 400 },
    ]);
  });
});

describe('planning the comp lane', () => {
  const border = 7680;
  const segments = [
    { take: 0, from: 0, to: border },
    { take: 1, from: border, to: 15360 },
  ];

  it('one take plays as it is, with the take clip’s own edges', () => {
    const plan = planComp(wholeTake([{ ...span(1), fadeIn: 0.25 }], 1), [{ ...span(1), fadeIn: 0.25 }], { tempo });
    expect(plan).toEqual([{ take: 1, ref: 'clip1', start: 0, length: 15360, offsetSec: 0, fadeIn: 0.25 }]);
  });

  it('two takes meet in an equal-power crossfade centred on the border (10 ms)', () => {
    const [a, b] = planComp(segments, spans, { tempo });
    // 5 ms (9.6 ticks, 10 after rounding) each side of the border.
    expect(a).toMatchObject({ take: 0, start: 0, length: border + 10 });
    expect(b).toMatchObject({ take: 1, start: border - 10, length: 15360 - border + 10 });
    // The fades are the overlap, so the outgoing clip is silent exactly where the incoming one is whole.
    const overlap = 20 / TPS;
    expect(a!.fadeOut).toBeCloseTo(overlap, 6);
    expect(b!.fadeIn).toBeCloseTo(overlap, 6);
    expect(a!.start + a!.length - b!.start).toBe(20);
    // Both clips play their own audio at the same song time: trims follow the take's position.
    expect(b!.offsetSec).toBeCloseTo((border - 10) / TPS, 9);
    // The comp starts at the take's start and ends at its end: no fades added there.
    expect(a!.fadeIn).toBeUndefined();
    expect(b!.fadeOut).toBeUndefined();
  });

  it('the crossfade length is adjustable and 0 is a hard cut', () => {
    const [a, b] = planComp(segments, spans, { tempo, crossfadeSec: 0.04 });
    expect(a!.start + a!.length - b!.start).toBe(76); // 40 ms = 76.8 ticks → 38 each side, rounded
    const [c, d] = planComp(segments, spans, { tempo, crossfadeSec: 0 });
    expect(c!.length).toBe(border);
    expect(d!.start).toBe(border);
    expect(c!.fadeOut).toBeUndefined();
    expect(d!.fadeIn).toBeUndefined();
  });

  it('the crossfade cannot reach past a take’s audio or a short neighbour', () => {
    // Take 1 starts exactly at the border: nothing of it before the border to cross into.
    const late = [span(0), span(1, border, 7680)];
    const [a, b] = planComp(segments, late, { tempo });
    expect(a!.start + a!.length).toBe(border);
    expect(b!.start).toBe(border);
    // The two takes still dip instead of clicking: a short equal-power fade each side of the cut.
    expect(a!.fadeOut).toBeGreaterThan(0);
    expect(b!.fadeIn).toBeGreaterThan(0);
    // A 4-tick segment: the crossfade is at most half of it each way.
    const tiny = [
      { take: 0, from: 0, to: border },
      { take: 1, from: border, to: border + 4 },
      { take: 2, from: border + 4, to: 15360 },
    ];
    const plan = planComp(tiny, spans, { tempo });
    expect(plan[1]!.length).toBeLessThanOrEqual(4 + 2 + 2);
  });

  it('a comp that starts inside a take or leaves a gap fades in and out instead of clicking', () => {
    const [a, b] = planComp(
      [
        { take: 0, from: 1920, to: 3840 },
        { take: 1, from: 9600, to: 11520 },
      ],
      spans,
      { tempo },
    );
    for (const c of [a!, b!]) {
      expect(c.fadeIn).toBeCloseTo(0.01, 6);
      expect(c.fadeOut).toBeCloseTo(0.01, 6);
    }
    expect(a!.start).toBe(1920);
    expect(a!.length).toBe(1920);
  });

  it('a clip that was split and plays on in the same take is not blended', () => {
    // Two clips of take 0 that continue each other in the sample.
    const split = [span(0, 0, 7680), span(0, 7680, 7680)];
    const [a, b] = planComp(wholeTake(split, 0), split, { tempo });
    // Each clip is its own sound, but where they meet the sample goes on: butt-joined, no overlap and no fades.
    expect(a!.start + a!.length).toBe(b!.start);
    expect(a!.fadeOut).toBeUndefined();
    expect(b!.fadeIn).toBeUndefined();
  });

  it('reading the comp back gives the segments it was planned from (no drift over edits)', () => {
    let segs = swipeSegments(wholeTake(spans, 2), spans, 0, 3841, 7001);
    segs = swipeSegments(segs, spans, 1, 5000, 9001);
    for (let i = 0; i < 5; i++) {
      const plan = planComp(segs, spans, { tempo });
      const again = readComp(plan.map((p) => ({ start: p.start, length: p.length, take: p.take })));
      expect(again).toEqual(segs);
      segs = again;
    }
  });
});
