import { describe, expect, it } from 'vitest';
import type { BeatSpec } from '@core/beat/spec';
import type { InstrumentChannel } from '@core/model/types';
import { createTestServices } from '../testing';
import { applyBeatSpec } from './apply';

const beat = (over: Partial<BeatSpec> = {}): BeatSpec => ({
  title: 'Night trap',
  bars: 2,
  bpm: 140,
  tracks: [
    { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 10, vel: 0.6 }] },
    { name: 'Hat', sound: 'hat', notes: [{ step: 0 }, { step: 6.5, len: 0.5 }] },
    { name: '808', sound: '808', notes: [{ step: 0, len: 10, key: 29 }], volume: 0.9, params: { decay: 99, nope: 1 } },
  ],
  ...over,
});

describe('applyBeatSpec', () => {
  it('writes a new pattern, reusing the project drums and adding the rest, as one undo step', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const applied = applyBeatSpec(s, beat());
    const p = s.doc.getState().project;

    expect(p.transport.bpm).toBe(140);
    const pattern = p.patterns[applied.patternId]!;
    expect(pattern).toMatchObject({ name: 'Night trap', stepCount: 32, length: 32 * 240 });
    expect(s.view.getState().currentPatternId).toBe(applied.patternId);

    // The default project's Kick and Hat samplers are reused; the 808 is a new channel.
    const kick = applied.channels.kick!;
    expect(before.channels[kick]?.name).toBe('Kick');
    expect(before.channels[applied.channels.hat!]?.name).toBe('Hat');
    expect(before.channels[applied.channels['808']!]).toBeUndefined();
    expect(applied.created).toEqual([applied.channels['808']]);

    const ticks = (id: string) =>
      Object.values(pattern.notes[id as never] ?? {})
        .map((n) => n.tick)
        .sort((a, b) => a - b);
    expect(ticks(kick)).toEqual([0, 2400]);
    expect(ticks(applied.channels.hat!)).toEqual([0, 1560]);
    const bass = Object.values(pattern.notes[applied.channels['808']!] ?? {})[0];
    expect(bass).toMatchObject({ tick: 0, length: 2400, key: 29 });

    // Mix settings only go to the channel the assistant made; params are clamped, unknown ones ignored.
    const ch808 = p.channels[applied.channels['808']!] as InstrumentChannel;
    expect(ch808.volume).toBe(0.9);
    expect(ch808.plugin.params.nope).toBeUndefined();
    expect((p.channels[kick] as InstrumentChannel).volume).toBe((before.channels[kick] as InstrumentChannel).volume);

    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('changes the same pattern in place for a follow-up', () => {
    const s = createTestServices();
    const first = applyBeatSpec(s, beat());
    const second = applyBeatSpec(
      s,
      beat({
        title: 'Night trap v2',
        bars: 1,
        bpm: undefined,
        tracks: [
          { name: 'Kick', sound: 'kick', notes: [{ step: 4 }] },
          { name: '808', sound: '808', notes: [{ step: 4, len: 4, key: 31 }] },
        ],
      }),
      first,
    );
    const p = s.doc.getState().project;
    expect(second.patternId).toBe(first.patternId);
    expect(second.channels['808']).toBe(first.channels['808']);
    const pattern = p.patterns[first.patternId]!;
    expect(pattern.name).toBe('Night trap v2');
    expect(pattern.stepCount).toBe(16);
    // The hat the first version wrote is gone; the rest is rewritten.
    expect(pattern.notes[first.channels.hat!]).toBeUndefined();
    expect(Object.values(pattern.notes[first.channels.kick!] ?? {}).map((n) => n.tick)).toEqual([960]);
    expect(p.patternOrder.filter((id) => id === first.patternId)).toHaveLength(1);
  });

  it('starts a new pattern when the previous one was deleted', () => {
    const s = createTestServices();
    const first = applyBeatSpec(s, beat());
    s.history.undo();
    const again = applyBeatSpec(s, beat(), first);
    expect(s.doc.getState().project.patterns[again.patternId]).toBeDefined();
  });
});
