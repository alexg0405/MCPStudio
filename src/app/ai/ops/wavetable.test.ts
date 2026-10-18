import { describe, expect, it } from 'vitest';
import { framesOfState, harmonicAmps } from '@agstudio/sdk/dsp/wavetable-frames';
import type { ChannelId } from '@core/model/types';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

function setup() {
  const s = createTestServices();
  const run = (actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
  run([{ op: 'add_channel', ref: '@wt', plugin: 'agstudio.wavetable', name: 'Table synth' }]);
  const channelId = () => s.doc.getState().project.channelOrder.find((id) => s.doc.getState().project.channels[id]?.name === 'Table synth') as ChannelId;
  const plugin = () => {
    const ch = s.doc.getState().project.channels[channelId()];
    if (ch?.kind !== 'instrument') throw new Error('not an instrument');
    return ch.plugin;
  };
  return { s, run, plugin };
}

describe('wavetable_shape', () => {
  it('gives the channel a table from harmonic lists and puts it on oscillator 1, in one undo step', () => {
    const { s, run, plugin } = setup();
    const steps = s.history.steps().done.length;
    const r = run([
      {
        op: 'wavetable_shape',
        channel: 'Table synth',
        frames: [{ harmonics: [1] }, { harmonics: [1, 0.5, 0.33, 0.25] }, { harmonics: [1, 0, 0.33, 0, 0.2] }],
        position: 0.5,
      },
    ]);
    expect(r.warnings).toEqual([]);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    const frames = framesOfState(plugin().state);
    expect(frames).toHaveLength(3);
    expect(Array.from(harmonicAmps(frames[1]!, 4)).map((x) => +x.toFixed(2))).toEqual([1, 0.5, 0.33, 0.25]);
    expect(plugin().params.osc1Table).toBe('user');
    expect(plugin().params.osc1Position).toBe(0.5);
    expect(plugin().params.osc2Table).toBe('basic');
    s.history.undo();
    expect(plugin().state).toBeUndefined();
    expect(plugin().params.osc1Table).toBe('basic');
  });

  it('can use oscillator 2 or both, turning an oscillator that was off on', () => {
    const { run, plugin } = setup();
    run([{ op: 'wavetable_shape', channel: 'Table synth', frames: [{ harmonics: [1, 1] }], oscillator: 'both' }]);
    expect(plugin().params.osc1Table).toBe('user');
    expect(plugin().params.osc2Table).toBe('user');
    expect(Number(plugin().params.osc2Level)).toBeGreaterThan(0);
  });

  it('refuses what it cannot make, and says why', () => {
    const { s, run, plugin } = setup();
    const before = plugin();
    for (const bad of [
      { frames: [] },
      { frames: [{ harmonics: [] }] },
      { frames: [{ harmonics: [0, 0] }] },
      { frames: [{ harmonics: Array.from({ length: 200 }, () => 1) }] },
      { frames: Array.from({ length: 40 }, () => ({ harmonics: [1] })) },
    ]) {
      const r = run([{ op: 'wavetable_shape', channel: 'Table synth', ...bad }]);
      expect(r.warnings.length, JSON.stringify(bad).slice(0, 60)).toBeGreaterThan(0);
      expect(plugin()).toEqual(before);
    }
    run([{ op: 'add_channel', plugin: 'agstudio.3xosc', name: 'Other' }]);
    const wrong = run([{ op: 'wavetable_shape', channel: 'Other', frames: [{ harmonics: [1] }] }]);
    expect(wrong.warnings.join(' ')).toMatch(/not a Wavetable/);
    void s;
  });
});
