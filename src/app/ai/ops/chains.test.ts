import { describe, expect, it } from 'vitest';
import { MASTER } from '@core/model/types';
import { pluginCatalog } from '../catalog';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';
import { createTestServices } from '../../testing';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const project = (s: S) => s.doc.getState().project;
const insertByName = (s: S, name: string) => Object.values(project(s).mixer.inserts).find((i) => i.name === name)!;
const plugins = (s: S, name: string) => insertByName(s, name).fx.map((f) => f.plugin.pluginId.replace('agstudio.', ''));

describe('add_chain and save_chain', () => {
  it('puts a vocal chain on a track as part of the answer’s one undo step, sending to returns made in the same answer', () => {
    const s = createTestServices();
    const before = project(s);
    const res = run(s, [
      { op: 'add_insert', name: 'Reverb' },
      { op: 'add_insert', name: 'Delay' },
      { op: 'add_insert', ref: '@vox', name: 'Lead vocal' },
      { op: 'add_chain', insert: '@vox', chain: 'clean pop' },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes.at(-1)).toMatch(/^Put “Clean pop vocal” on .*: 5 effects and Reverb send -14 dB, Delay send -20 dB$/);
    expect(plugins(s, 'Lead vocal')).toEqual(['eq-pro', 'compressor', 'de-esser', 'saturator', 'doubler']);
    expect(insertByName(s, 'Lead vocal').routes.map((r) => r.to)).toHaveLength(3);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });

  it('replaces by default and appends on request, and says why when it can’t', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_insert', name: 'Vox' },
      { op: 'add_chain', insert: 'Vox', chain: 'Podcast voice' },
      { op: 'add_chain', insert: 'Vox', chain: 'Rap vocal', mode: 'replace' },
      { op: 'add_chain', insert: 'Vox', chain: 'Podcast voice', mode: 'append' },
      { op: 'add_chain', insert: 'Vox', chain: 'No such chain' },
      { op: 'add_chain', insert: 'Nowhere', chain: 'Rap vocal' },
    ]);
    expect(plugins(s, 'Vox')).toEqual(['eq-pro', 'compressor', 'de-esser', 'saturator', 'doubler', 'delay', 'reverb', 'gate', 'eq-pro', 'compressor'].slice(0, 10));
    // The 10-slot limit left the rest of the appended chain out, with a warning.
    expect(res.warnings.some((w) => /Podcast voice: left out .*no free effect slot/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /no effect chain "No such chain"/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /no mixer track "Nowhere"/.test(w))).toBe(true);
  });

  it('works on the master and keeps a chain name from the musician’s own library', () => {
    const s = createTestServices();
    s.presets.saveChain({ name: 'Warm bus', steps: [{ pluginId: 'agstudio.saturator', preset: 'Tape warmth', label: 'tape' }] });
    run(s, [{ op: 'add_chain', insert: 'master', chain: 'warm bus' }]);
    expect(project(s).mixer.inserts[MASTER]!.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.saturator']);
  });

  it('saves a track’s effects as a chain the musician can use again', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_insert', name: 'Vox' },
      { op: 'add_effect', insert: 'Vox', plugin: 'agstudio.compressor', params: [{ name: 'ratio', value: 6 }] },
      { op: 'add_effect', insert: 'Vox', plugin: 'agstudio.de-esser', preset: 'Harsh S’s' },
      { op: 'save_chain', insert: 'Vox', name: 'My vox' },
      { op: 'save_chain', insert: 'master', name: 'Nothing' },
    ]);
    expect(res.changes.some((c) => /Saved the 2 effects on .* as the chain “My vox”/.test(c))).toBe(true);
    expect(res.warnings.some((w) => /no effects to save/.test(w))).toBe(true);
    const mine = s.presets.chains();
    expect(mine.map((c) => c.name)).toEqual(['My vox']);
    expect(mine[0]!.steps[0]).toMatchObject({ pluginId: 'agstudio.compressor', params: { ratio: 6 } });
    expect(mine[0]!.steps[1]).toMatchObject({ pluginId: 'agstudio.de-esser', params: { frequency: 6500, mode: 'split' } });
  });
});

describe('what the AI is told about chains', () => {
  it('the plugin catalog lists the new effects and every chain with its effects, yours too', () => {
    const s = createTestServices();
    s.presets.saveChain({ name: 'Mine', description: 'My own.', steps: [{ pluginId: 'agstudio.stereo', label: 'stereo' }] });
    const text = pluginCatalog(s.plugins, s.presets).text;
    expect(text).toMatch(/- agstudio\.de-esser "De-esser" \[Dynamics\]: .*\n {2}params: frequency: float 3000\.\.12000 Hz log = 7000/);
    expect(text).toContain('presets: Gentle, Bright vocal, Harsh S’s, Podcast voice (wideband), Deep voice, Tame bright cymbals');
    expect(text).toMatch(/- agstudio\.doubler "Doubler" \[Modulation\]: /);
    expect(text).toContain('presets: Tight double, Wide pop, Rap ad-lib, Subtle thickener, Backing vocal stack');
    expect(text).toContain('Effect chains (add_chain action');
    for (const name of ['Clean pop vocal', 'Rap vocal', 'Airy ballad', 'Lo-fi vocal', 'Trap auto-tune vocal', 'Podcast voice'])
      expect(text).toContain(`- "${name}"`);
    expect(text).toContain('- "Mine" (the musician\'s own): My own.');
    expect(text).toContain('a send to the reverb return when the song has one');
  });

  it('get_chains lists them and gives one in full', () => {
    const s = createTestServices();
    const all = runReadTool(s, 'get_chains', {}) as { chains: { name: string; effects: number; source: string }[] };
    expect(all.chains.map((c) => c.name)).toContain('Trap auto-tune vocal');
    expect(all.chains.find((c) => c.name === 'Podcast voice')).toMatchObject({ effects: 5, source: 'factory' });
    const one = runReadTool(s, 'get_chains', { chain: 'trap' }) as { name: string; effects: { plugin_name: string; preset?: string; send_to?: string }[] };
    expect(one.name).toBe('Trap auto-tune vocal');
    expect(one.effects[0]).toMatchObject({ plugin_name: 'Tune', preset: 'Hard tune robot (A minor)' });
    expect(one.effects.some((e) => e.send_to === 'delay')).toBe(true);
    expect(runReadTool(s, 'get_chains', { chain: 'zzz' })).toMatchObject({ error: expect.stringContaining('no chain "zzz"') });
  });
});
