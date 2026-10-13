import { describe, expect, it } from 'vitest';
import { FakeEngine } from '@engine/fake-engine';
import { MASTER, type InsertId } from '@core/model/types';
import { createServices } from '../services';
import {
  addEffect,
  addEffectToSelectedInsert,
  addMixerInsert,
  deleteInsert,
  moveEffectBy,
  moveInsertBy,
  removeEffect,
  replaceEffect,
  routeChannel,
  toggleEffect,
} from './mixer';

function setup() {
  const engine = new FakeEngine();
  const services = createServices({ platform: 'mac', createEngine: () => engine });
  const project = () => services.doc.getState().project;
  return { services, engine, project, insert: (i: number) => project().mixer.order[i] as InsertId };
}

describe('mixer actions', () => {
  it('ships the built-in effects', () => {
    const { services } = setup();
    const ids = services.plugins.list('effect').map((e) => e.def.id);
    for (const id of ['eq', 'filter', 'delay', 'reverb', 'compressor', 'distortion'])
      expect(ids).toContain(`agstudio.${id}`);
  });

  it('adds an effect with default params as one undo step', () => {
    const { services, project, insert } = setup();
    const ins = insert(1);
    const slot = addEffect(services, ins, 'agstudio.reverb')!;
    const added = project().mixer.inserts[ins]!.fx[0]!;
    expect(added).toMatchObject({ id: slot, enabled: true, mix: 1, plugin: { pluginId: 'agstudio.reverb' } });
    expect(added.plugin.params.decay).toBe(services.plugins.get('agstudio.reverb')!.params.decay!.default);
    expect(services.history.status().undoLabel).toBe('Add Reverb');
    services.history.undo();
    expect(project().mixer.inserts[ins]!.fx).toEqual([]);
  });

  it('refuses instruments and unknown plugins', () => {
    const { services, insert } = setup();
    expect(addEffect(services, insert(1), 'agstudio.sampler')).toBeNull();
    expect(addEffect(services, insert(1), 'user.nope')).toBeNull();
    expect(services.history.status().canUndo).toBe(false);
  });

  it('replaces, reorders, bypasses and removes effects', () => {
    const { services, project, insert } = setup();
    const ins = insert(2);
    const a = addEffect(services, ins, 'agstudio.eq')!;
    const b = addEffect(services, ins, 'agstudio.delay')!;
    expect(replaceEffect(services, ins, a, 'agstudio.compressor')).toBe(true);
    moveEffectBy(services, ins, b, -1);
    toggleEffect(services, ins, a);
    const fx = project().mixer.inserts[ins]!.fx;
    expect(fx.map((s) => [s.id, s.plugin.pluginId, s.enabled])).toEqual([
      [b, 'agstudio.delay', true],
      [a, 'agstudio.compressor', false],
    ]);
    removeEffect(services, ins, b);
    expect(project().mixer.inserts[ins]!.fx.map((s) => s.id)).toEqual([a]);
  });

  it('adds, moves and deletes inserts, keeping the selection and routing valid', () => {
    const { services, project, insert } = setup();
    const count = project().mixer.order.length;
    const added = addMixerInsert(services);
    expect(project().mixer.order).toHaveLength(count + 1);
    expect(project().mixer.inserts[added]!.name).toBe(`Insert ${count}`);
    expect(services.session.getState().selectedInsertId).toBe(added);

    const kick = project().channelOrder[0]!;
    routeChannel(services, kick, added);
    expect(project().channels[kick]).toMatchObject({ output: added });

    moveInsertBy(services, added, -1);
    expect(project().mixer.order.indexOf(added)).toBe(count - 1);

    deleteInsert(services, added);
    expect(project().mixer.inserts[added]).toBeUndefined();
    expect(project().channels[kick]).toMatchObject({ output: MASTER });
    // null = the master.
    expect(services.session.getState().selectedInsertId).toBeNull();

    deleteInsert(services, MASTER);
    expect(project().mixer.inserts[MASTER]).toBeDefined();
    expect(insert(0)).toBe(MASTER);
  });

  it('adds browser effects to the selected insert, or the master', () => {
    const { services, project, insert } = setup();
    expect(addEffectToSelectedInsert(services, 'agstudio.eq')).toMatchObject({ insertId: MASTER });
    services.session.getState().selectInsert(insert(3));
    const added = addEffectToSelectedInsert(services, 'agstudio.delay')!;
    expect(added.insertId).toBe(insert(3));
    expect(project().mixer.inserts[insert(3)]!.fx.map((s) => s.id)).toEqual([added.slotId]);
    for (let i = 1; i < 10; i++) addEffectToSelectedInsert(services, 'agstudio.eq');
    expect(addEffectToSelectedInsert(services, 'agstudio.eq')).toBeNull();
    expect(services.session.getState().toasts.at(-1)?.text).toBe('Insert 3 has no free effect slot');
  });

  it('reads meters through the engine host', () => {
    const { services, engine, project } = setup();
    const order = project().mixer.order;
    engine.meterLevels.set(order[1]!, [0.5, 0.25]);
    const out = new Float32Array(order.length * 2).fill(-1);
    services.engine.readMeters(order, out);
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 0.5, 0.25]);
  });
});
