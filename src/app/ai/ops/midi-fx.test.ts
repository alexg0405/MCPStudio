import { describe, expect, it } from 'vitest';
import { makeHarmonySong } from '@core/harmony/test-song';
import { midiFxOf } from '@core/query/midi-fx';
import { notesSorted } from '@core/query/queries';
import type { ChannelId } from '@core/model/types';
import { pluginCatalog } from '../catalog';
import { projectContext } from '../context';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

type TestServices = ReturnType<typeof createTestServices>;

function setup() {
  const s = createTestServices();
  const song = makeHarmonySong(['C', 'F', 'G', 'C']);
  s.history.load(song.project);
  s.view.getState().setCurrentPattern(song.patternId);
  const channel = song.channels.lead as ChannelId;
  return { s, song, channel };
}
const run = (s: TestServices, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const chainOf = (s: TestServices, channel: ChannelId) => midiFxOf(s.doc.getState().project.channels[channel]);

describe('the Studio’s MIDI effects actions', () => {
  it('adds an effect with settings and a preset, as one undo step', () => {
    const { s, channel } = setup();
    const steps = s.history.steps().done.length;
    const turn = run(s, [
      { op: 'add_midi_effect', channel, effect: 'arp', ref: '@arp', preset: 'Trance gate', params: [{ name: 'rate', value: '1/8' }, { name: 'Octaves', value: 2 }] },
      { op: 'add_midi_effect', channel, effect: 'humanize', params: [{ name: 'timing', value: 5 }] },
    ]);
    expect(turn.warnings).toEqual([]);
    expect(turn.changes[0]).toMatch(/^Added Arpeggiator to .* \(preset Trance gate, Rate 1\/8 note, Octaves 2\)/);
    const chain = chainOf(s, channel);
    expect(chain.map((slot) => slot.effect)).toEqual(['arp', 'humanize']);
    expect(chain[0]!.params).toMatchObject({ pattern: 'up', rate: '1/8', octaves: 2, gate: 0.5, velocity: 'accent' });
    expect(chain[1]!.params.timing).toBe(5);
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect(s.history.undo()).toBe(true);
    expect(chainOf(s, channel)).toEqual([]);
  });

  it('edits by number, name or @ref: settings, bypass and place; removes one or all', () => {
    const { s, channel } = setup();
    run(s, [
      { op: 'add_midi_effect', channel, effect: 'arp', ref: '@a' },
      { op: 'add_midi_effect', channel, effect: 'chord' },
      { op: 'edit_midi_effect', channel, effect: '@a', params: [{ name: 'swing', value: 40 }], enabled: false },
    ]);
    expect(chainOf(s, channel)[0]).toMatchObject({ enabled: false, params: { swing: 0.4 } });
    const moved = run(s, [{ op: 'edit_midi_effect', channel, effect: 'Chord', position: 1, params: [{ name: 'shape', value: 'm7' }] }]);
    expect(moved.changes[0]).toMatch(/^Chord on .*: Shape Minor 7th, place 1/);
    expect(chainOf(s, channel).map((slot) => slot.effect)).toEqual(['chord', 'arp']);
    expect(run(s, [{ op: 'edit_midi_effect', channel, effect: '2', enabled: true }]).warnings).toEqual([]);
    expect(chainOf(s, channel)[1]!.enabled).toBe(true);
    run(s, [{ op: 'remove_midi_effect', channel, effect: 'arp' }]);
    expect(chainOf(s, channel).map((slot) => slot.effect)).toEqual(['chord']);
    const gone = run(s, [{ op: 'remove_midi_effect', channel, effect: 'all' }]);
    expect(gone.changes[0]).toMatch(/Removed all 1 MIDI effect from/);
    expect(chainOf(s, channel)).toEqual([]);
  });

  it('says what is wrong: an unknown effect or setting, a missing effect, an audio channel', () => {
    const { s, channel } = setup();
    expect(run(s, [{ op: 'add_midi_effect', channel, effect: 'kazoo' }]).warnings.join(' ')).toMatch(/there is no MIDI effect "kazoo"/);
    const bad = run(s, [{ op: 'add_midi_effect', channel, effect: 'echo', params: [{ name: 'sparkle', value: 1 }, { name: 'repeats', value: 'many' }] }]);
    expect(bad.warnings.join(' ')).toMatch(/no setting "sparkle"[\s\S]*repeats: can't use "many"/);
    expect(run(s, [{ op: 'edit_midi_effect', channel, effect: 'arp' }]).warnings.join(' ')).toMatch(/has no MIDI effect "arp"/);
    expect(run(s, [{ op: 'remove_midi_effect', channel, effect: '3' }]).warnings.join(' ')).toMatch(/has 1 MIDI effect, not 3/);
    expect(run(s, [{ op: 'midi_effects_chain', channel, chain: 'No such chain' }]).warnings.join(' ')).toMatch(/there is no MIDI effects chain/);
  });

  it('loads a ready-made chain, replacing or appending', () => {
    const { s, channel } = setup();
    run(s, [{ op: 'add_midi_effect', channel, effect: 'transpose' }]);
    const loaded = run(s, [{ op: 'midi_effects_chain', channel, chain: 'pluck arp' }]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.changes[0]).toMatch(/now has the “Pluck arp” chain \(Arpeggiator, Humanize\)/);
    expect(chainOf(s, channel).map((slot) => slot.effect)).toEqual(['arp', 'humanize']);
    run(s, [{ op: 'midi_effects_chain', channel, chain: 'Dub echo', mode: 'append' }]);
    expect(chainOf(s, channel).map((slot) => slot.effect)).toEqual(['arp', 'humanize', 'echo']);
  });

  it('renders the effects into the notes and removes them, in one undo step', () => {
    const { s, song, channel } = setup();
    run(s, [{ op: 'add_midi_effect', channel, effect: 'echo', params: [{ name: 'repeats', value: 2 }] }]);
    const before = notesSorted(s.doc.getState().project.patterns[song.patternId]!.notes[channel]).length;
    const steps = s.history.steps().done.length;
    const turn = run(s, [{ op: 'render_midi_effects', channel }]);
    expect(turn.warnings).toEqual([]);
    expect(turn.changes[0]).toMatch(/Rendered the MIDI effects of .* into \d+ notes in 1 pattern/);
    expect(chainOf(s, channel)).toEqual([]);
    expect(notesSorted(s.doc.getState().project.patterns[song.patternId]!.notes[channel]).length).toBeGreaterThan(before);
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect(run(s, [{ op: 'render_midi_effects', channel }]).warnings.join(' ')).toMatch(/has no MIDI effects that change its notes/);
  });

  it('automates an effect knob', () => {
    const { s, channel } = setup();
    run(s, [{ op: 'add_midi_effect', channel, effect: 'echo' }]);
    const turn = run(s, [{ op: 'automate', target: { kind: 'midi_effect', channel, midi_effect: 'echo', param: 'feedback' }, from_bar: 1, bars: 2, points: [{ bar: 0, value: 0.2 }, { bar: 2, value: 0.9 }] }]);
    expect(turn.warnings).toEqual([]);
    const refused = run(s, [{ op: 'automate', target: { kind: 'midi_effect', channel, midi_effect: '1', param: 'delay' }, from_bar: 1, bars: 2, points: [{ bar: 0, value: 0 }] }]);
    expect(refused.warnings.join(' ')).toMatch(/can't be automated/);
  });
});

describe('what the Studio reads about MIDI effects', () => {
  it('lists the effects and chains in the catalog, with settings and presets', () => {
    const { s } = setup();
    const text = pluginCatalog(s.plugins, s.presets).text;
    expect(text).toMatch(/MIDI effects \(for instrument channels, add_midi_effect action/);
    expect(text).toMatch(/- arp "Arpeggiator": [\s\S]*params: pattern: one of up \(Up\) \| down/);
    expect(text).toMatch(/MIDI effect chains \(midi_effects_chain action\):\n- "Pluck arp"/);
    for (const id of ['arp', 'chord', 'scale', 'repeat', 'echo', 'humanize', 'velocity', 'transpose', 'length', 'random']) expect(text).toContain(`- ${id} "`);
  });

  it('shows a channel’s chain in the project text and in get_channel, and nothing for a channel without one', () => {
    const { s, channel } = setup();
    expect(projectContext(s)).not.toContain('MIDI effects (before the instrument');
    run(s, [
      { op: 'add_midi_effect', channel, effect: 'arp', params: [{ name: 'rate', value: '1/8' }] },
      { op: 'add_midi_effect', channel, effect: 'chord', enabled: false },
    ]);
    expect(projectContext(s)).toContain('MIDI effects (before the instrument, in this order): Arpeggiator (rate 1/8) → bypassed Chord');
    const read = runReadTool(s, 'get_channel', { channel }) as { midi_effects: { n: number; effect: string; enabled: boolean; params: { id: string; value: unknown }[] }[] };
    expect(read.midi_effects.map((slot) => [slot.n, slot.effect, slot.enabled])).toEqual([[1, 'arp', true], [2, 'chord', false]]);
    expect(read.midi_effects[0]!.params.find((param) => param.id === 'rate')!.value).toBe('1/8');
  });

  it('the settings action and read know the record choice', () => {
    const { s } = setup();
    expect(run(s, [{ op: 'settings', record_midi_fx: 'generated' }]).warnings).toEqual([]);
    expect(s.prefs.getState().recordMidiFx).toBe('generated');
    expect((runReadTool(s, 'get_settings') as { record_midi_fx: string }).record_midi_fx).toBe('generated');
  });
});
