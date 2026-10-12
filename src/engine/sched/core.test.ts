import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { NoteId, PatternId } from '@core/model/types';
import { addChannel, setChannelProp } from '@core/ops/channels';
import { addNote, setStep } from '@core/ops/notes';
import { plan, tickAtTime, type Timeline } from './core';
import { collectNotes, patternModeSource, type NoteEvent } from './events';

const tl = (loop: Timeline['loop'], endTick = 1e9): Timeline => ({ spt: 0.001, loop, endTick });

describe('plan', () => {
  it('covers the window in one segment when nothing wraps', () => {
    const p = plan({ tick: 0, time: 10, iter: 0 }, 10.1, tl({ start: 0, end: 1000 }));
    expect(p.segs).toEqual([{ tick0: 0, tick1: expect.closeTo(100, 9), time0: 10, iter: 0, spt: 0.001 }]);
    expect(p.next).toEqual({ tick: expect.closeTo(100, 9), time: expect.closeTo(10.1, 9), iter: 0 });
  });

  it('wraps exactly at the loop end and bumps the iteration', () => {
    const p = plan({ tick: 950, time: 0, iter: 3 }, 0.12, tl({ start: 0, end: 1000 }));
    expect(p.segs).toHaveLength(2);
    expect(p.segs[0]).toMatchObject({ tick0: 950, tick1: 1000, iter: 3 });
    expect(p.segs[1]).toMatchObject({ tick0: 0, iter: 4 });
    expect(p.segs[1]!.time0).toBeCloseTo(0.05, 9);
    expect(p.segs[1]!.tick1).toBeCloseTo(70, 6);
  });

  it('handles windows spanning several short loops', () => {
    const p = plan({ tick: 0, time: 0, iter: 0 }, 0.35, tl({ start: 0, end: 100 }));
    expect(p.segs.map((s) => s.iter)).toEqual([0, 1, 2, 3]);
    expect(p.next.iter).toBe(3);
  });

  it('ends a non-looping timeline', () => {
    const p = plan({ tick: 0, time: 0, iter: 0 }, 1, tl(null, 200));
    expect(p.ended).toBe(true);
    expect(p.segs).toEqual([{ tick0: 0, tick1: 200, time0: 0, iter: 0, spt: 0.001 }]);
  });

  it('continues seamlessly across pumps', () => {
    const t = tl({ start: 0, end: 1000 });
    let c = { tick: 0, time: 0, iter: 0 };
    const ticks: number[] = [];
    for (let k = 1; k <= 119; k++) {
      const p = plan(c, k * 0.025, t);
      for (const s of p.segs) ticks.push(s.tick1 - s.tick0);
      c = p.next;
    }
    expect(ticks.reduce((a, b) => a + b, 0)).toBeCloseTo(2975, 3);
    expect(c.iter).toBe(2);
  });

  it('maps time back to ticks', () => {
    const p = plan({ tick: 950, time: 0, iter: 0 }, 0.12, tl({ start: 0, end: 1000 }));
    expect(tickAtTime(p.segs, 0.02)).toEqual({ tick: expect.closeTo(970, 6), iter: 0 });
    expect(tickAtTime(p.segs, 0.06)).toEqual({ tick: expect.closeTo(10, 6), iter: 1 });
    expect(tickAtTime(p.segs, -1)).toBeNull();
  });
});

describe('collectNotes', () => {
  function project() {
    let p = createEmptyProject();
    const ch = makeInstrumentChannel('Kick', makePluginInstance('x', 1, {}));
    const pid = p.patternOrder[0] as PatternId;
    p = produce(p, (d) => {
      addChannel(d, ch);
      for (const s of [0, 4, 8, 12]) setStep(d, pid, ch.id, s, true, { rootKey: 60 });
    });
    return { p, pid, ch };
  }

  it('finds pattern notes in a range and repeats them each loop of the clip', () => {
    const { p, pid } = project();
    const { source, length } = patternModeSource(p, pid);
    expect(length).toBe(3840);
    const out: NoteEvent[] = [];
    collectNotes(source, 0, 3840, out);
    expect(out.map((e) => e.start)).toEqual([0, 960, 1920, 2880]);
    const long = { ...source, clips: [{ ...source.clips[0]!, length: 3840 * 2 }] };
    const out2: NoteEvent[] = [];
    collectNotes(long, 3000, 5000, out2);
    expect(out2.map((e) => [e.start, e.key.endsWith(':1')])).toEqual([
      [3840, true],
      [4800, true],
    ]);
  });

  it('skips muted channels and applies swing to odd steps', () => {
    const { p, pid, ch } = project();
    const muted = produce(p, (d) => setChannelProp(d, ch.id, 'muted', true));
    const out: NoteEvent[] = [];
    collectNotes(patternModeSource(muted, pid).source, 0, 3840, out);
    expect(out).toEqual([]);

    const swung = produce(p, (d) => {
      d.transport.swing = 1;
      addNote(d, pid, ch.id, { id: 'odd' as NoteId, tick: 240, length: 240, key: 62, velocity: 1 });
    });
    const out2: NoteEvent[] = [];
    collectNotes(patternModeSource(swung, pid).source, 0, 960, out2);
    expect(out2.find((e) => e.pitch === 62)?.start).toBe(360);
  });

  it('cuts notes at the clip end and honours the clip offset', () => {
    const { p, pid } = project();
    const clip = { clipId: 'c1', patternId: pid, start: 10000, length: 1500, offset: 960 };
    const out: NoteEvent[] = [];
    collectNotes({ project: p, clips: [clip] }, 0, 20000, out);
    // Content 960..2460 → notes at content 960 and 1920 land at 10000 and 10960.
    expect(out.map((e) => e.start)).toEqual([10000, 10960]);
    expect(out.every((e) => e.end <= 11500)).toBe(true);
  });
});
