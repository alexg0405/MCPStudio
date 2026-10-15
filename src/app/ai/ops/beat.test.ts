import { describe, expect, it } from 'vitest';
import type { InstrumentChannel, PatternClip } from '@core/model/types';
import { createTestServices } from '../../testing';
import { applyAnswer, type ApplyContext } from '../apply';
import type { AiAction } from '../schema';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[], ctx: ApplyContext = { previousBeat: null }) =>
  applyAnswer(s, { message: 'ok', actions }, ctx);
const project = (s: S) => s.doc.getState().project;
const patternNamed = (s: S, name: string) => Object.values(project(s).patterns).find((p) => p.name === name);

const drums = (title: string, extra: Partial<AiAction> = {}): AiAction => ({
  op: 'beat',
  title,
  style: 'trap',
  bars: 1,
  tracks: [
    { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 10 }] },
    { name: 'Lead', sound: 'lead', notes: [{ step: 0, key: 72 }] },
  ],
  ...extra,
});

describe('the beat action', () => {
  it('writes a second beat of an answer as a new pattern, sharing channels by name', () => {
    const s = createTestServices();
    const res = run(s, [drums('Verse', { ref: '@verse' }), drums('Drop', { ref: '@drop' })]);
    expect(res.warnings).toEqual([]);
    const verse = patternNamed(s, 'Verse');
    const drop = patternNamed(s, 'Drop');
    expect(verse && drop && verse.id !== drop.id).toBe(true);
    // Both beats play the same Kick and Lead channels.
    expect(Object.keys(verse!.notes).sort()).toEqual(Object.keys(drop!.notes).sort());
    const leads = project(s).channelOrder.filter((id) => project(s).channels[id]!.name === 'Lead');
    expect(leads).toHaveLength(1);
    // The answer's last beat is the one follow-ups change.
    expect(res.beat?.patternId).toBe(drop!.id);
  });

  it('registers each beat as an @ref the same answer can place', () => {
    const s = createTestServices();
    const res = run(s, [
      drums('Verse', { ref: '@verse' }),
      drums('Drop', { pattern: 'new', ref: '@drop' }),
      { op: 'place_pattern', pattern: '@verse', bar: 1, track: 1, times: 2 },
      { op: 'place_pattern', pattern: '@drop', bar: 3, track: 1, times: 2 },
    ]);
    expect(res.warnings).toEqual([]);
    const clips = Object.values(project(s).playlist.clips) as PatternClip[];
    const names = clips.sort((a, b) => a.start - b.start).map((c) => project(s).patterns[c.patternId]!.name);
    expect(names).toEqual(['Verse', 'Verse', 'Drop', 'Drop']);
  });

  it('rewrites the conversation’s beat for a follow-up, or the pattern it names', () => {
    const s = createTestServices();
    const first = run(s, [drums('Verse')]);
    const followUp = run(s, [drums('Verse 2')], { previousBeat: first.beat });
    expect(followUp.beat?.patternId).toBe(first.beat?.patternId);
    expect(followUp.changes).toEqual(['Wrote the beat “Verse 2” (Kick, Lead)']);
    // A new beat, then a rewrite of the first one by name.
    run(s, [drums('Drop', { pattern: 'new' })], { previousBeat: followUp.beat });
    const named = run(s, [drums('Verse 3', { pattern: 'Verse 2' })]);
    expect(named.changes).toEqual(['Rewrote the beat “Verse 3” (Kick, Lead)']);
    expect(named.beat?.patternId).toBe(first.beat?.patternId);
    expect(Object.values(project(s).patterns).map((p) => p.name)).toEqual(['Pattern 1', 'Verse 3', 'Drop']);
    const missing = run(s, [drums('X', { pattern: 'Bridge' })]);
    expect(missing.warnings).toEqual(['beat: there is no pattern "Bridge"']);
  });

  it('applies levels the AI gives even to channels it reuses, in dB or as a negative volume', () => {
    const s = createTestServices();
    const kickId = project(s).channelOrder.find((id) => project(s).channels[id]!.name === 'Kick')!;
    run(s, [
      drums('Verse', {
        tracks: [
          { name: 'Kick', sound: 'kick', volume_db: -6, notes: [{ step: 0 }] },
          { name: 'Hat', sound: 'hat', volume: -12, notes: [{ step: 2 }] },
        ],
      }),
    ]);
    const kick = project(s).channels[kickId] as InstrumentChannel;
    expect(kick.volume).toBeCloseTo(0.501, 3);
    const hat = Object.values(project(s).channels).find((c) => c.name === 'Hat') as InstrumentChannel;
    expect(hat.volume).toBeCloseTo(0.251, 3);
  });

  it('accents notes without a velocity in the beat’s style', () => {
    const s = createTestServices();
    run(s, [
      {
        op: 'beat',
        title: 'Hats',
        style: 'house',
        bars: 1,
        tracks: [{ name: 'Hat', sound: 'hat', notes: [0, 1, 2, 3].map((step) => ({ step })) }],
      },
    ]);
    const hat = Object.values(project(s).channels).find((c) => c.name === 'Hat')!;
    const notes = Object.values(patternNamed(s, 'Hats')!.notes[hat.id] ?? {}).sort((a, b) => a.tick - b.tick);
    // House accents the "and" of each beat.
    expect(notes[2]!.velocity).toBeGreaterThan(notes[1]!.velocity + 0.3);
    // An explicit style without swing gives the song the style's swing (it had none).
    expect(project(s).transport.swing).toBe(0.2);
  });
});
