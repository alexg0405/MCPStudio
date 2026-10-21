import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../../model/defaults';
import type { InstrumentChannel, MidiFxSlot, Project } from '../../model/types';
import { addChannel } from '../../ops/channels';
import { MAX_MIDI_FX } from '../../midi-fx/registry';
import { repairProject } from '../migrate';

/** A project with one instrument channel whose `midiFx` is set to `chain` as saved (it may be damaged). */
function withChain(chain: unknown): Project {
  const channel = makeInstrumentChannel('Keys', makePluginInstance('agstudio.test', 1, {}));
  return produce(createEmptyProject(), (draft) => {
    addChannel(draft, channel);
    (draft.channels[channel.id] as { midiFx?: unknown }).midiFx = chain;
  });
}

const chainOf = (project: Project): MidiFxSlot[] | undefined => (Object.values(project.channels)[0] as InstrumentChannel).midiFx;

describe('repair of MIDI effects chains', () => {
  it('leaves a good chain alone, with no messages, and repairing again changes nothing', () => {
    const good: MidiFxSlot[] = [
      { id: 'mfx_a' as MidiFxSlot['id'], effect: 'arp', enabled: true, params: { octaves: 2, rate: '1/8' } },
      { id: 'mfx_b' as MidiFxSlot['id'], effect: 'from-the-future', enabled: false, params: { anything: 1 } },
    ];
    const project = withChain(good);
    const { project: repaired, repairs } = repairProject(project);
    expect(repairs).toEqual([]);
    expect(repaired).toEqual(project);
    expect(repairProject(repaired).repairs).toEqual([]);
  });

  it('fixes a damaged chain: drops what is not a slot, makes ids unique, clamps settings, fills in switches', () => {
    const damaged = [
      42,
      { id: 'mfx_a', effect: 'arp', enabled: 'yes', params: { octaves: 99, gate: 'loud', rate: '1/7', pattern: 'up', odd: { x: 1 } } },
      { id: 'mfx_a', effect: 'chord', enabled: true },
      { effect: 7 },
    ];
    const { project, repairs } = repairProject(withChain(damaged));
    const chain = chainOf(project)!;
    expect(chain.map((slot) => slot.effect)).toEqual(['arp', 'chord']);
    expect(new Set(chain.map((slot) => slot.id)).size).toBe(2);
    expect(chain[0]).toMatchObject({ enabled: true, params: { octaves: 4, gate: 0.8, rate: '1/16', pattern: 'up' } });
    expect(chain[0]!.params.odd).toBeUndefined();
    expect(chain[1]).toMatchObject({ enabled: true, params: {} });
    expect(repairs.join(' ')).toMatch(/MIDI effect/);
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('removes a chain that is not a list, an empty one, and chains past the limit', () => {
    expect(chainOf(repairProject(withChain('arp')).project)).toBeUndefined();
    expect(chainOf(repairProject(withChain([])).project)).toBeUndefined();
    const many = Array.from({ length: MAX_MIDI_FX + 3 }, (_, i) => ({ id: `mfx_${i}`, effect: 'transpose', enabled: true, params: {} }));
    expect(chainOf(repairProject(withChain(many)).project)).toHaveLength(MAX_MIDI_FX);
  });
});
