import { describe, expect, it } from 'vitest';
import { defineEffect, p, type PluginDef } from '@agstudio/sdk';
import { pluginCatalog } from './catalog';

const def = defineEffect({
  id: 'test.pads',
  name: 'Pads',
  version: 1,
  params: {
    pad1Sound: p.enum(['kick', 'snare', 'hat'] as const, 'kick', { label: 'Pad 1 sound' }),
    pad1Tune: p.float(-24, 24, 0, { label: 'Pad 1 tune', unit: 'st' }),
    pad2Sound: p.enum(['kick', 'snare', 'hat'] as const, 'snare', { label: 'Pad 2 sound' }),
    pad2Tune: p.float(-24, 24, 0, { label: 'Pad 2 tune', unit: 'st' }),
    pad3Sound: p.enum(['kick', 'snare', 'hat'] as const, 'hat', { label: 'Pad 3 sound' }),
    pad3Tune: p.float(-24, 24, 0, { label: 'Pad 3 tune', unit: 'st' }),
    // Not a family: the numbers skip, or the ranges differ.
    osc1Level: p.float(0, 1, 1),
    osc3Level: p.float(0, 1, 1),
    lfo1Rate: p.float(0.1, 20, 1, { unit: 'Hz' }),
    lfo2Rate: p.float(0.1, 10, 1, { unit: 'Hz' }),
  },
  create: () => {
    throw new Error('not in tests');
  },
}) as PluginDef;

const catalogOf = (d: PluginDef) =>
  pluginCatalog({ list: (k: string) => (k === 'effect' ? [{ def: d }] : []), scripts: () => [] } as never).text;

describe('the plugin catalog', () => {
  it('folds numbered settings with the same range into one line, defaults in order', () => {
    const text = catalogOf(def);
    expect(text).toContain('pad1..3Sound "Pad N sound": one of kick | snare | hat = kick, snare, hat');
    expect(text).toContain('pad1..3Tune "Pad N tune": float -24..24 st = 0;');
    expect(text).toContain('A numbered range such as pad1..16Sound stands for one setting per number');
    expect(text.split('params:')[1]).not.toContain('pad2Sound');
  });

  it('keeps settings apart when the numbers skip or the ranges differ', () => {
    const text = catalogOf(def);
    expect(text).toContain('osc1Level: float 0..1 = 1; osc3Level: float 0..1 = 1');
    expect(text).toContain('lfo1Rate: float 0.1..20 Hz = 1; lfo2Rate: float 0.1..10 Hz = 1');
  });
});
