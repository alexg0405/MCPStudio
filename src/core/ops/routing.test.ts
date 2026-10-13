import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { targetKey } from '../model/targets';
import { MASTER, type InsertId, type LinkId, type ParamTarget, type Project, type SlotId } from '../model/types';
import { canRoute, routingEdges, topologicalOrder, wouldCycle } from '../query/routing';
import { addChannel, removeChannel } from './channels';
import { addFxSlot, removeFxSlot, removeInsert } from './mixer';
import { removeRoute, routeOnlyTo, setRoute, setRouteLevel, setSlotSidechain } from './routing';

beforeEach(() => setIdSource(seededBytes(3)));

function setup() {
  const p = createEmptyProject({ now: new Date(0) });
  const [a, b, c] = p.mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
  return { p, a, b, c };
}
const routes = (p: Project, id: InsertId) => p.mixer.inserts[id]!.routes;
const link = (id: string, target: ParamTarget) => ({ id: id as LinkId, cc: 1, channel: null, target, min: 0, max: 1 });

describe('routing ops', () => {
  it('adds and updates routes, refusing loops, self-routes and the master', () => {
    const { p, a, b } = setup();
    let ok = false;
    let q = produce(p, (d) => {
      ok = setRoute(d, a, b, { level: 0.5, pre: true });
    });
    expect(ok).toBe(true);
    expect(routes(q, a)).toEqual([
      { to: MASTER, level: 1, pre: false },
      { to: b, level: 0.5, pre: true },
    ]);
    q = produce(q, (d) => {
      ok = setRoute(d, b, a); // b → a closes a → b
    });
    expect(ok).toBe(false);
    q = produce(q, (d) => {
      expect(setRoute(d, a, a)).toBe(false);
      expect(setRoute(d, MASTER, a)).toBe(false);
      expect(setRoute(d, a, b, { level: 99 })).toBe(true); // updating an existing route is never a loop
      setRouteLevel(d, a, MASTER, -1);
    });
    expect(routes(q, a)).toEqual([
      { to: MASTER, level: 0, pre: false },
      { to: b, level: 1.905, pre: true },
    ]);
    q = produce(q, (d) => removeRoute(d, a, MASTER));
    expect(routes(q, a).map((r) => r.to)).toEqual([b]);
  });

  it('routes to one track only, keeping the old routes when that would loop', () => {
    const { p, a, b, c } = setup();
    const q = produce(p, (d) => {
      expect(routeOnlyTo(d, a, b)).toBe(true);
      expect(routeOnlyTo(d, b, c)).toBe(true);
      expect(routeOnlyTo(d, c, a)).toBe(false); // a → b → c → a
    });
    expect(routes(q, a)).toEqual([{ to: b, level: 1, pre: false }]);
    expect(routes(q, c)).toEqual([{ to: MASTER, level: 1, pre: false }]);
    expect(canRoute(q.mixer, c, a)).toBe(false);
    expect(canRoute(q.mixer, c, MASTER)).toBe(true);
    expect(topologicalOrder(q.mixer).indexOf(a)).toBeLessThan(topologicalOrder(q.mixer).indexOf(b));
    produce(q, (d) => {
      expect(wouldCycle(d.mixer.inserts, c, a)).toBe(true); // works on drafts too
    });
  });

  it('sets sidechains unless they would loop, and counts them as edges', () => {
    const { p, a, b } = setup();
    let slot!: SlotId;
    let q = produce(p, (d) => {
      slot = addFxSlot(d, a, makePluginInstance('agstudio.compressor', 1, {}))!;
      setRoute(d, a, b);
    });
    expect(q.mixer.inserts[a]!.fx[0]!.sidechain).toBeNull();
    q = produce(q, (d) => {
      expect(setSlotSidechain(d, a, slot, b)).toBe(false); // b → a closes a → b
      expect(setSlotSidechain(d, a, slot, MASTER)).toBe(false); // everything reaches the master
      expect(setSlotSidechain(d, a, slot, a)).toBe(false);
      removeRoute(d, a, b);
      expect(setSlotSidechain(d, a, slot, b)).toBe(true);
    });
    expect(q.mixer.inserts[a]!.fx[0]!.sidechain).toBe(b);
    expect(routingEdges(q.mixer.inserts)).toContainEqual({ from: b, to: a, kind: 'sidechain', slotId: slot });
    expect(canRoute(q.mixer, a, b)).toBe(false); // a → b would loop through the sidechain
    q = produce(q, (d) => {
      setSlotSidechain(d, a, slot, null);
    });
    expect(q.mixer.inserts[a]!.fx[0]!.sidechain).toBeNull();
  });
});

describe('deleting things that routes and links refer to', () => {
  it('removing an insert drops routes and sidechains to it and links to its controls', () => {
    const { p, a, b, c } = setup();
    let slot!: SlotId;
    const q = produce(p, (d) => {
      routeOnlyTo(d, a, b); // a only goes to b: it falls back to the master when b goes
      setRoute(d, c, b, { level: 0.3 });
      slot = addFxSlot(d, c, makePluginInstance('agstudio.compressor', 1, {}))!;
      setSlotSidechain(d, c, slot, b);
      d.controllers['lnk_1' as LinkId] = link('lnk_1', { kind: 'insert', insertId: b, param: 'volume' });
      d.controllers['lnk_2' as LinkId] = link('lnk_2', { kind: 'route', insertId: c, to: b });
      d.controllers['lnk_3' as LinkId] = link('lnk_3', { kind: 'insert', insertId: c, param: 'pan' });
      removeInsert(d, b);
    });
    expect(routes(q, a)).toEqual([{ to: MASTER, level: 1, pre: false }]);
    expect(routes(q, c)).toEqual([{ to: MASTER, level: 1, pre: false }]);
    expect(q.mixer.inserts[c]!.fx[0]!.sidechain).toBeNull();
    expect(Object.keys(q.controllers)).toEqual(['lnk_3']);
  });

  it('removing a channel or an effect slot drops the links to its controls', () => {
    const { p, a } = setup();
    const ch = makeInstrumentChannel('Lead', makePluginInstance('agstudio.3xosc', 1, {}));
    let slot!: SlotId;
    let q = produce(p, (d) => {
      addChannel(d, ch);
      slot = addFxSlot(d, a, makePluginInstance('agstudio.eq', 1, {}))!;
      d.controllers['lnk_ch' as LinkId] = link('lnk_ch', {
        kind: 'plugin',
        owner: { kind: 'channel', channelId: ch.id },
        paramId: 'cutoff',
      });
      d.controllers['lnk_fx' as LinkId] = link('lnk_fx', {
        kind: 'plugin',
        owner: { kind: 'fx', insertId: a, slotId: slot },
        paramId: 'midGain',
      });
      d.controllers['lnk_mix' as LinkId] = link('lnk_mix', { kind: 'slot', insertId: a, slotId: slot, param: 'mix' });
      d.controllers['lnk_keep' as LinkId] = link('lnk_keep', { kind: 'tempo' });
    });
    q = produce(q, (d) => removeChannel(d, ch.id));
    expect(Object.keys(q.controllers).sort()).toEqual(['lnk_fx', 'lnk_keep', 'lnk_mix']);
    q = produce(q, (d) => removeFxSlot(d, a, slot));
    expect(Object.keys(q.controllers)).toEqual(['lnk_keep']);
  });
});

describe('targetKey', () => {
  it('is distinct for distinct targets', () => {
    const t: ParamTarget[] = [
      { kind: 'channel', channelId: 'ch_a' as never, param: 'volume' },
      { kind: 'channel', channelId: 'ch_a' as never, param: 'pan' },
      { kind: 'insert', insertId: 'ins_a' as never, param: 'volume' },
      { kind: 'slot', insertId: 'ins_a' as never, slotId: 'fx_a' as never, param: 'mix' },
      { kind: 'route', insertId: 'ins_a' as never, to: MASTER },
      { kind: 'plugin', owner: { kind: 'channel', channelId: 'ch_a' as never }, paramId: 'volume' },
      { kind: 'plugin', owner: { kind: 'fx', insertId: 'ins_a' as never, slotId: 'fx_a' as never }, paramId: 'mix' },
      { kind: 'tempo' },
    ];
    expect(new Set(t.map(targetKey)).size).toBe(t.length);
  });
});
