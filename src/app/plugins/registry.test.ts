import { describe, expect, it } from 'vitest';
import { defineEffect, defineInstrument, p } from '@agstudio/sdk';
import { PluginRegistry, validatePluginDef } from './registry';

const synth = defineInstrument({
  id: 'user.synth',
  name: 'Synth',
  version: 1,
  params: { cutoff: p.float(20, 20000, 1000, { scale: 'log' }) },
  create: () => {
    throw new Error('not used');
  },
});

describe('validatePluginDef', () => {
  it('accepts a well-formed definition', () => {
    expect(validatePluginDef(synth)).toEqual([]);
  });

  it('explains what is wrong', () => {
    expect(validatePluginDef(undefined)[0]).toMatch(/default export/);
    const bad = {
      ...synth,
      id: '',
      version: 0,
      params: { x: p.float(10, 5, 7), y: p.float(0, 1, 0.5, { scale: 'log' }) },
    };
    const problems = validatePluginDef(bad).join('\n');
    expect(problems).toMatch(/id must be/);
    expect(problems).toMatch(/version/);
    expect(problems).toMatch(/"x": min must be < max/);
    expect(problems).toMatch(/"y": log scale/);
  });
});

describe('PluginRegistry', () => {
  it('syncs a source, reports changed ids and keeps built-ins on collisions', () => {
    const reg = new PluginRegistry();
    const events: string[][] = [];
    reg.subscribe((ids) => events.push(ids));
    const builtin = defineEffect({
      id: 'agstudio.eq',
      name: 'EQ',
      version: 1,
      params: {},
      create: () => ({}) as never,
    });
    reg.sync('builtin', [{ path: '/b/eq', def: builtin }]);
    reg.sync('user', [
      { path: '/u/synth', def: synth },
      { path: '/u/clash', def: { ...builtin, name: 'Mine' } },
      { path: '/u/broken', def: { nope: true } },
    ]);
    expect(reg.get('user.synth')).toBe(synth);
    expect(reg.get('agstudio.eq')?.name).toBe('EQ');
    expect(reg.loadErrors().map((e) => e.path)).toEqual(['/u/clash', '/u/broken']);
    expect(events).toEqual([['agstudio.eq'], ['user.synth']]);

    // Removing a user plugin reports it; replacing a definition reports it too.
    reg.sync('user', []);
    expect(reg.get('user.synth')).toBeUndefined();
    expect(events[events.length - 1]).toEqual(['user.synth']);
    expect(reg.list().map((e) => e.def.id)).toEqual(['agstudio.eq']);
  });
});
