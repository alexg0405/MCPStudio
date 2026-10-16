import { beforeEach, describe, expect, it } from 'vitest';
import { produce, type Draft } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { MASTER, type InsertId, type Project } from '../model/types';
import { addChannel } from '../ops/channels';
import { addFxSlot, moveInsert, setInsertProp } from '../ops/mixer';
import { clearRoutes, routeOnlyTo, setRoute, setSlotSidechain } from '../ops/routing';
import { findEmptyInsert, type EmptyInsertRules } from './mixer';

beforeEach(() => setIdSource(seededBytes(7)));

/** A fresh project: master, then "Insert 1" … "Insert 16" (all empty). */
const fresh = () => createEmptyProject({ now: new Date(0) });
const insertAt = (p: Project, n: number) => p.mixer.order[n] as InsertId;
const ducker = () => makePluginInstance('agstudio.ducker', 1, {});

/** Every insert except `keep` (and the master) is taken: its volume is off unity. */
function takeAllBut(d: Draft<Project>, keep: InsertId) {
  for (const id of d.mixer.order) if (id !== MASTER && id !== keep) setInsertProp(d, id, 'volume', 0.5);
}

// Recipes below use block bodies: immer would take a returned value (a boolean or id) as the new state.

describe('findEmptyInsert', () => {
  it('returns the first unused "Insert N" in mixer order', () => {
    const p = fresh();
    expect(findEmptyInsert(p)).toBe(insertAt(p, 1));
  });

  it('returns null when nothing is empty, and never the master', () => {
    const p = fresh();
    const q = produce(p, (d) => {
      setInsertProp(d, MASTER, 'name', 'Insert 99');
      takeAllBut(d, MASTER);
    });
    expect(findEmptyInsert(q)).toBeNull();
    expect(findEmptyInsert(q, { anyCaseName: true })).toBeNull();
  });

  it('follows mixer order, not insert ids', () => {
    const p = fresh();
    const last = insertAt(p, 16);
    const q = produce(p, (d) => {
      moveInsert(d, last, 1);
      takeAllBut(d, last);
    });
    expect(findEmptyInsert(q)).toBe(last);
  });

  describe('with the default (filter) rules, rejects an insert that', () => {
    const cases: [string, (d: Draft<Project>, id: InsertId, p: Project) => void][] = [
      ['has an effect', (d, id) => void addFxSlot(d, id, ducker())],
      ['is off unity volume', (d, id) => setInsertProp(d, id, 'volume', 0.5)],
      ['is panned', (d, id) => setInsertProp(d, id, 'pan', 0.3)],
      ['is muted', (d, id) => setInsertProp(d, id, 'muted', true)],
      ['is soloed', (d, id) => setInsertProp(d, id, 'solo', true)],
      ['has no route', (d, id) => clearRoutes(d, id)],
      ['has two routes', (d, id, p) => void setRoute(d, id, insertAt(p, 2), {})],
      ['routes somewhere other than the master', (d, id, p) => void routeOnlyTo(d, id, insertAt(p, 2))],
      ['is renamed', (d, id) => setInsertProp(d, id, 'name', 'Drums')],
      [
        'has a channel playing through it',
        (d, id) => addChannel(d, makeInstrumentChannel('Lead', makePluginInstance('x.synth', 1, {}), { output: id })),
      ],
      ['is routed into by another insert', (d, id, p) => void setRoute(d, insertAt(p, 2), id, {})],
      [
        'is the sidechain source of an effect',
        (d, id, p) => {
          const slot = addFxSlot(d, insertAt(p, 2), ducker())!;
          setSlotSidechain(d, insertAt(p, 2), slot, id);
        },
      ],
    ];
    for (const [label, change] of cases) {
      it(label, () => {
        const p = fresh();
        const first = insertAt(p, 1);
        const q = produce(p, (d) => {
          change(d, first, p);
        });
        expect(findEmptyInsert(q)).not.toBe(first);
      });
    }
  });

  it('by default accepts a route below unity level or a pre-fader route', () => {
    const p = fresh();
    const first = insertAt(p, 1);
    const level = produce(p, (d) => {
      setRoute(d, first, MASTER, { level: 0.5 });
    });
    const pre = produce(p, (d) => {
      setRoute(d, first, MASTER, { pre: true });
    });
    expect(findEmptyInsert(level)).toBe(first);
    expect(findEmptyInsert(pre)).toBe(first);
  });

  describe('anyCaseName', () => {
    it('accepts "insert N" in any case, with the name trimmed', () => {
      const p = fresh();
      const first = insertAt(p, 1);
      const lower = produce(p, (d) => {
        setInsertProp(d, first, 'name', 'insert 1');
      });
      // setInsertProp trims names, so the padded name is set on the draft directly.
      const padded = produce(p, (d) => {
        d.mixer.inserts[first]!.name = '  Insert 1 ';
      });
      expect(findEmptyInsert(lower)).not.toBe(first);
      expect(findEmptyInsert(lower, { anyCaseName: true })).toBe(first);
      expect(findEmptyInsert(padded)).not.toBe(first);
      expect(findEmptyInsert(padded, { anyCaseName: true })).toBe(first);
    });

    it('still rejects names that are not "insert N"', () => {
      const p = fresh();
      const first = insertAt(p, 1);
      for (const name of ['Insert', 'Insert x', 'Insert 1a', 'Lead 1']) {
        const q = produce(p, (d) => {
          setInsertProp(d, first, 'name', name);
        });
        expect(findEmptyInsert(q, { anyCaseName: true })).not.toBe(first);
      }
    });
  });

  describe('ignorePanAndSolo', () => {
    const rules: EmptyInsertRules = { ignorePanAndSolo: true };

    it('lets a panned or soloed insert through', () => {
      const p = fresh();
      const first = insertAt(p, 1);
      const panned = produce(p, (d) => {
        setInsertProp(d, first, 'pan', -0.4);
      });
      const soloed = produce(p, (d) => {
        setInsertProp(d, first, 'solo', true);
      });
      expect(findEmptyInsert(panned, rules)).toBe(first);
      expect(findEmptyInsert(soloed, rules)).toBe(first);
    });

    it('still rejects a muted insert, a changed volume or an effect', () => {
      const p = fresh();
      const first = insertAt(p, 1);
      const muted = produce(p, (d) => {
        setInsertProp(d, first, 'muted', true);
      });
      const volume = produce(p, (d) => {
        setInsertProp(d, first, 'volume', 0.5);
      });
      const fx = produce(p, (d) => {
        addFxSlot(d, first, ducker());
      });
      for (const q of [muted, volume, fx]) expect(findEmptyInsert(q, rules)).not.toBe(first);
    });
  });

  describe('unityPostRoute', () => {
    const rules: EmptyInsertRules = { unityPostRoute: true };

    it('rejects a route below unity level or a pre-fader route', () => {
      const p = fresh();
      const first = insertAt(p, 1);
      const level = produce(p, (d) => {
        setRoute(d, first, MASTER, { level: 0.5 });
      });
      const pre = produce(p, (d) => {
        setRoute(d, first, MASTER, { pre: true });
      });
      expect(findEmptyInsert(level, rules)).not.toBe(first);
      expect(findEmptyInsert(pre, rules)).not.toBe(first);
    });

    it('accepts a unity, post-fader route to the master', () => {
      const p = fresh();
      expect(findEmptyInsert(p, rules)).toBe(insertAt(p, 1));
    });
  });
});
