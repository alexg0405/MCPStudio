import { describe, expect, it } from 'vitest';
import type { InstrumentChannel } from '@core/model/types';
import { findMixLayout } from '../../mix/layout';
import { pinnedFor } from '../../mix/level-step';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const project = (s: S) => s.doc.getState().project;

const beat: AiAction = {
  op: 'beat',
  title: 'Verse',
  style: 'drill',
  bars: 1,
  tracks: [
    { name: 'Kick', sound: 'kick', notes: [{ step: 0 }] },
    { name: 'Snare', sound: 'snare', notes: [{ step: 8 }] },
    { name: '808', sound: '808', notes: [{ step: 0, len: 8, key: 29 }] },
    { name: 'Strings', sound: 'strings', notes: [{ step: 0, len: 16, key: 60 }] },
  ],
};

describe('mix actions', () => {
  it('sets up the mix for the song an answer built, then asks for leveling', () => {
    const s = createTestServices();
    const res = run(s, [beat, { op: 'setup_mix', style: 'drill', level: true }, { op: 'edit_insert', insert: 'Kick', volume_db: -4 }]);
    expect(res.warnings).toEqual([]);
    const layout = findMixLayout(project(s));
    const kick = Object.values(project(s).channels).find((c) => c.name === 'Kick') as InstrumentChannel;
    expect(kick.output).toBe(layout.buses.kick);
    const strings = Object.values(project(s).channels).find((c) => c.name === 'Strings') as InstrumentChannel;
    expect(strings.output).toBe(layout.buses.chords);
    expect(res.changes[1]).toMatch(/^Set up the Drill mix: Kick, Drums, 808, Chords buses, Reverb \(plate reverb\) return/);
    // The fader the AI set on the Kick bus stays, and leveling leaves it alone.
    expect(project(s).mixer.inserts[layout.buses.kick!]!.volume).toBeCloseTo(Math.pow(10, -4 / 20));
    const level = res.after.filter((a) => a.kind === 'level_mix');
    expect(level).toEqual([{ kind: 'level_mix', style: 'drill' }]);
    expect([...pinnedFor.get(level[0]!)!]).toEqual([layout.buses.kick]);
  });

  it('fills the gaps of an existing song by default and guesses the style', () => {
    const s = createTestServices();
    run(s, [beat]);
    const res = run(s, [{ op: 'setup_mix' }]);
    expect(res.changes.join()).toMatch(/Set up the \w+ mix/);
    const again = run(s, [{ op: 'setup_mix' }]);
    expect(again.changes).toEqual(['The mix was already set up']);
    expect(again.edited).toBe(false);
  });

  it('asks for one leveling per answer, from the bar it names', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'level_mix', style: 'house' },
      { op: 'level_mix', style: 'trap', from_bar: 9, bars: 4 },
    ]);
    expect(res.after).toEqual([{ kind: 'level_mix', style: 'trap', fromTick: 8 * 3840, bars: 4 }]);
    expect(res.edited).toBe(false);
  });
});
