import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { MASTER, type InsertId, type Project, type SlotId } from '../model/types';
import { addFxSlot, setInsertProp, toggleSoloInsert } from '../ops/mixer';
import { clearRoutes, removeRoute, routeOnlyTo, setRoute, setSlotSidechain } from '../ops/routing';
import { effectivelyMutedInserts, soloState } from './mixer';
import { playableEdges } from './routing';

beforeEach(() => setIdSource(seededBytes(5)));

function setup() {
  const p = createEmptyProject({ now: new Date(0) });
  const [a, b, c, e] = p.mixer.order.slice(1, 5) as [InsertId, InsertId, InsertId, InsertId];
  return { p, a, b, c, e };
}

describe('playableEdges', () => {
  it('lists routes in mixer order, then sidechains', () => {
    const { p, a, b, c } = setup();
    let slot!: SlotId;
    const q = produce(p, (d) => {
      setRoute(d, a, b, { level: 0.5 });
      slot = addFxSlot(d, b, makePluginInstance('agstudio.ducker', 1, {}))!;
      setSlotSidechain(d, b, slot, c);
    });
    const edges = playableEdges(q.mixer);
    expect(edges.filter((x) => x.kind === 'route').map((x) => [x.from, x.to])).toEqual(
      q.mixer.order.slice(1).flatMap((id) =>
        id === a
          ? [
              [a, MASTER],
              [a, b],
            ]
          : [[id, MASTER]],
      ),
    );
    expect(edges.filter((x) => x.kind === 'sidechain')).toEqual([{ from: c, to: b, kind: 'sidechain', slotId: slot }]);
    expect(playableEdges(q.mixer)).toBe(edges);
  });

  it('drops loops (routes win over sidechains, mixer order decides), self, missing and repeated targets', () => {
    const { p, a, b, c } = setup();
    let slot!: SlotId;
    // Written behind the ops' backs, as a damaged file could be.
    const q = produce(p, (d) => {
      const ins = d.mixer.inserts;
      ins[a]!.routes = [
        { to: b, level: 1, pre: false },
        { to: b, level: 0.5, pre: true },
        { to: a, level: 1, pre: false },
        { to: 'ins_gone' as InsertId, level: 1, pre: false },
      ];
      ins[b]!.routes = [
        { to: a, level: 1, pre: false },
        { to: c, level: 1, pre: false },
      ];
      ins[c]!.routes = [{ to: MASTER, level: 1, pre: false }];
      ins[MASTER]!.routes = [{ to: a, level: 1, pre: false }];
      slot = addFxSlot(d, a, makePluginInstance('agstudio.compressor', 1, {}))!;
      ins[a]!.fx[0]!.sidechain = c; // c is downstream of a (a → b → c): a loop
      const s2 = addFxSlot(d, c, makePluginInstance('agstudio.compressor', 1, {}))!;
      ins[c]!.fx.find((s) => s.id === s2)!.sidechain = a; // fine: a already reaches c
    });
    const edges = playableEdges(q.mixer).map((x) => `${x.kind}:${x.from}>${x.to}`);
    expect(edges).toContain(`route:${a}>${b}`);
    expect(edges.filter((x) => x === `route:${a}>${b}`)).toHaveLength(1);
    expect(edges).not.toContain(`route:${b}>${a}`);
    expect(edges).not.toContain(`route:${a}>${a}`);
    expect(edges.some((x) => x.includes('ins_gone'))).toBe(false);
    expect(edges.some((x) => x.startsWith(`route:${MASTER}`))).toBe(false);
    expect(edges).toContain(`route:${b}>${c}`);
    expect(edges).not.toContain(`sidechain:${c}>${a}`);
    expect(edges).toContain(`sidechain:${a}>${c}`);
    expect(slot).toBeTruthy();
  });
});

describe('soloState', () => {
  /** a → bus b → master, c → master, e → a (feeds the soloed track). */
  function bus(p: Project, a: InsertId, b: InsertId, e: InsertId) {
    return produce(p, (d) => {
      routeOnlyTo(d, a, b);
      routeOnlyTo(d, e, a);
    });
  }

  it('keeps a soloed insert, its sources and its path to the master playing', () => {
    const { p, a, b, c, e } = setup();
    const q = produce(bus(p, a, b, e), (d) => toggleSoloInsert(d, a));
    const s = soloState(q.mixer.inserts);
    expect(s.active).toBe(true);
    expect([...s.soloed]).toEqual([a]);
    expect(s.audible.has(a) && s.audible.has(b) && s.audible.has(e) && s.audible.has(MASTER)).toBe(true);
    expect(s.audible.has(c)).toBe(false);
    const muted = effectivelyMutedInserts(q.mixer.inserts);
    expect(muted.has(c)).toBe(true);
    expect(muted.has(a) || muted.has(b) || muted.has(e) || muted.has(MASTER)).toBe(false);
  });

  it('soloing a bus plays everything routed into it, recursively', () => {
    const { p, a, b, c, e } = setup();
    const q = produce(bus(p, a, b, e), (d) => toggleSoloInsert(d, b));
    const muted = effectivelyMutedInserts(q.mixer.inserts);
    expect([a, b, e, MASTER].some((id) => muted.has(id))).toBe(false);
    expect(muted.has(c)).toBe(true);
  });

  it('ignores sidechains and keeps plain mutes', () => {
    const { p, a, b, c } = setup();
    const q = produce(p, (d) => {
      const slot = addFxSlot(d, a, makePluginInstance('agstudio.ducker', 1, {}))!;
      setSlotSidechain(d, a, slot, c);
      toggleSoloInsert(d, a);
      setInsertProp(d, b, 'muted', true);
    });
    const s = soloState(q.mixer.inserts);
    expect(s.audible.has(c)).toBe(false);
    expect(effectivelyMutedInserts(q.mixer.inserts).has(b)).toBe(true);
    // A soloed insert that is also muted stays muted.
    const r = produce(q, (d) => setInsertProp(d, a, 'muted', true));
    expect(effectivelyMutedInserts(r.mixer.inserts).has(a)).toBe(true);
  });

  it('everything is audible without a solo, and results are memoized', () => {
    const { p } = setup();
    const s = soloState(p.mixer.inserts);
    expect(s.active).toBe(false);
    expect(s.audible.size).toBe(p.mixer.order.length);
    expect(soloState(p.mixer.inserts)).toBe(s);
  });

  it('handles routing loops in damaged documents', () => {
    const { p, a, b } = setup();
    const q = produce(p, (d) => {
      d.mixer.inserts[a]!.routes = [{ to: b, level: 1, pre: false }];
      d.mixer.inserts[b]!.routes = [{ to: a, level: 1, pre: false }];
      d.mixer.inserts[a]!.solo = true;
    });
    const s = soloState(q.mixer.inserts);
    expect(s.audible.has(a) && s.audible.has(b)).toBe(true);
  });
});

describe('clearRoutes', () => {
  it('leaves the insert with no route', () => {
    const { p, a, b } = setup();
    const q = produce(p, (d) => {
      setRoute(d, a, b);
      clearRoutes(d, a);
      clearRoutes(d, 'ins_missing' as InsertId);
    });
    expect(q.mixer.inserts[a]!.routes).toEqual([]);
    const r = produce(q, (d) => {
      setRoute(d, a, MASTER);
      removeRoute(d, a, MASTER);
    });
    expect(r.mixer.inserts[a]!.routes).toEqual([]);
  });
});
