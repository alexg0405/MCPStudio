import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { produce } from 'immer';
import { History } from '../history/history';
import { createEmptyProject, makeInsert, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { faderToGain, formatGain, gainToFader, MAX_INSERT_VOLUME, UNITY_POSITION } from '../model/fader';
import { newId, seededBytes, setIdSource } from '../model/ids';
import { MASTER, type InsertId, type Project, type SlotId } from '../model/types';
import { effectivelyMutedInserts, insertLabel, pluginInstanceOf } from '../query/mixer';
import { addChannel, setChannelProp, setPluginParam } from './channels';
import {
  addFxSlot,
  addInsert,
  MAX_FX_SLOTS,
  moveFxSlot,
  moveInsert,
  removeFxSlot,
  removeInsert,
  replaceFxPlugin,
  setFxSlotEnabled,
  setFxSlotMix,
  setInsertProp,
  toggleSoloInsert,
} from './mixer';

beforeEach(() => {
  setIdSource(seededBytes(7));
});

const fx = (pluginId = 'agstudio.eq') => makePluginInstance(pluginId, 1, { gain: 0 });
const insertAt = (p: Project, i: number) => p.mixer.order[i] as InsertId;

describe('insert props', () => {
  it('clamps volume to +5.6 dB and pan to -1…1', () => {
    const p = createEmptyProject();
    const id = insertAt(p, 1);
    const q = produce(p, (d) => {
      setInsertProp(d, id, 'volume', 3);
      setInsertProp(d, id, 'pan', -2);
    });
    expect(q.mixer.inserts[id]).toMatchObject({ volume: MAX_INSERT_VOLUME, pan: -1 });
    const r = produce(q, (d) => {
      setInsertProp(d, id, 'volume', -1);
      setInsertProp(d, id, 'pan', Number.NaN);
    });
    expect(r.mixer.inserts[id]).toMatchObject({ volume: 0, pan: 0 });
  });

  it('renames, colours and never solos the master', () => {
    const p = createEmptyProject();
    const id = insertAt(p, 2);
    const q = produce(p, (d) => {
      setInsertProp(d, id, 'name', '  Drums  ');
      setInsertProp(d, id, 'color', '#c76b5b');
      setInsertProp(d, MASTER, 'solo', true);
      setInsertProp(d, id, 'name', '   ');
    });
    expect(q.mixer.inserts[id]).toMatchObject({ name: 'Drums', color: '#c76b5b' });
    expect(q.mixer.inserts[MASTER]!.solo).toBe(false);
    const r = produce(q, (d) => setInsertProp(d, id, 'color', undefined));
    expect('color' in r.mixer.inserts[id]!).toBe(false);
  });
});

describe('mute and solo', () => {
  it('solos exclusively among non-master inserts and toggles back', () => {
    const p = createEmptyProject();
    const [a, b] = [insertAt(p, 1), insertAt(p, 2)];
    const s1 = produce(p, (d) => {
      setInsertProp(d, a, 'muted', true);
      toggleSoloInsert(d, a);
    });
    expect(s1.mixer.inserts[a]).toMatchObject({ solo: true, muted: false });
    const muted1 = effectivelyMutedInserts(s1.mixer.inserts);
    expect(muted1.has(a)).toBe(false);
    expect(muted1.has(b)).toBe(true);
    expect(muted1.has(MASTER)).toBe(false);
    expect(muted1.size).toBe(p.mixer.order.length - 2);

    // Soloing another insert moves the solo; soloing the only solo clears it.
    const s2 = produce(s1, (d) => toggleSoloInsert(d, b));
    expect(s2.mixer.inserts[a]!.solo).toBe(false);
    expect(s2.mixer.inserts[b]!.solo).toBe(true);
    const s3 = produce(s2, (d) => toggleSoloInsert(d, b));
    expect(Object.values(s3.mixer.inserts).some((i) => i.solo)).toBe(false);
    expect(effectivelyMutedInserts(s3.mixer.inserts).size).toBe(0);
  });

  it('ignores solo on the master and keeps plain mutes', () => {
    const p = createEmptyProject();
    const a = insertAt(p, 3);
    const q = produce(p, (d) => {
      toggleSoloInsert(d, MASTER);
      setInsertProp(d, a, 'muted', true);
      setInsertProp(d, MASTER, 'muted', true);
    });
    expect(q.mixer.inserts[MASTER]!.solo).toBe(false);
    expect([...effectivelyMutedInserts(q.mixer.inserts)].sort()).toEqual([a, MASTER].sort());
  });

  it('memoizes by the identity of the inserts record', () => {
    const p = createEmptyProject();
    expect(effectivelyMutedInserts(p.mixer.inserts)).toBe(effectivelyMutedInserts(p.mixer.inserts));
  });
});

describe('inserts', () => {
  it('adds inserts after the master only', () => {
    const p = createEmptyProject();
    const a = makeInsert(newId.insert(), 'A');
    const b = makeInsert(newId.insert(), 'B');
    const q = produce(p, (d) => {
      addInsert(d, a, 0);
      addInsert(d, b);
      addInsert(d, makeInsert(MASTER, 'Fake master'));
      addInsert(d, { ...a, name: 'dupe' });
    });
    expect(q.mixer.order[0]).toBe(MASTER);
    expect(q.mixer.order[1]).toBe(a.id);
    expect(q.mixer.order[q.mixer.order.length - 1]).toBe(b.id);
    expect(q.mixer.order).toHaveLength(p.mixer.order.length + 2);
    expect(q.mixer.inserts[a.id]!.name).toBe('A');
    expect(q.mixer.inserts[MASTER]!.name).toBe('Master');
    expect(insertLabel(q, a.id)).toBe('Insert 1');
    expect(insertLabel(q, MASTER)).toBe('Master');
  });

  it('deleting an insert routes its channels to the master', () => {
    const p0 = createEmptyProject();
    const target = insertAt(p0, 4);
    const other = insertAt(p0, 5);
    const kick = makeInstrumentChannel('Kick', makePluginInstance('x', 1, {}));
    const snare = makeInstrumentChannel('Snare', makePluginInstance('x', 1, {}));
    const p = produce(p0, (d) => {
      addChannel(d, kick);
      addChannel(d, snare);
      setChannelProp(d, kick.id, 'output', target);
      setChannelProp(d, snare.id, 'output', other);
    });
    const q = produce(p, (d) => removeInsert(d, target));
    expect(q.mixer.inserts[target]).toBeUndefined();
    expect(q.mixer.order).not.toContain(target);
    expect(q.channels[kick.id]).toMatchObject({ output: MASTER });
    expect(q.channels[snare.id]).toMatchObject({ output: other });
  });

  it('never removes or moves the master', () => {
    const p = createEmptyProject();
    const a = insertAt(p, 1);
    const q = produce(p, (d) => {
      removeInsert(d, MASTER);
      moveInsert(d, MASTER, 5);
      moveInsert(d, a, 0);
    });
    expect(q).toBe(p);
    const r = produce(p, (d) => moveInsert(d, a, 99));
    expect(r.mixer.order[0]).toBe(MASTER);
    expect(r.mixer.order[r.mixer.order.length - 1]).toBe(a);
    expect(r.mixer.order).toHaveLength(p.mixer.order.length);
  });
});

describe('effect slots', () => {
  it('adds slots enabled and fully wet, up to ten per insert', () => {
    const p = createEmptyProject();
    const id = insertAt(p, 1);
    const ids: (SlotId | null)[] = [];
    const q = produce(p, (d) => {
      for (let i = 0; i < MAX_FX_SLOTS + 2; i++) ids.push(addFxSlot(d, id, fx()));
    });
    expect(q.mixer.inserts[id]!.fx).toHaveLength(MAX_FX_SLOTS);
    expect(ids.slice(MAX_FX_SLOTS)).toEqual([null, null]);
    expect(q.mixer.inserts[id]!.fx[0]).toMatchObject({ enabled: true, mix: 1, plugin: { pluginId: 'agstudio.eq' } });
    expect(new Set(q.mixer.inserts[id]!.fx.map((s) => s.id)).size).toBe(MAX_FX_SLOTS);
  });

  it('inserts at an index and refuses duplicate slot ids', () => {
    const p = createEmptyProject();
    const id = insertAt(p, 1);
    const q = produce(p, (d) => {
      addFxSlot(d, id, fx('a'), undefined, 'fx_a' as SlotId);
      addFxSlot(d, id, fx('b'), undefined, 'fx_b' as SlotId);
      addFxSlot(d, id, fx('c'), 0, 'fx_c' as SlotId);
      addFxSlot(d, id, fx('d'), undefined, 'fx_a' as SlotId);
    });
    expect(q.mixer.inserts[id]!.fx.map((s) => s.plugin.pluginId)).toEqual(['c', 'a', 'b']);
  });

  it('reorders slots without changing their ids or data', () => {
    const p0 = createEmptyProject();
    const id = insertAt(p0, 2);
    const p = produce(p0, (d) => {
      for (const name of ['eq', 'comp', 'delay', 'reverb']) addFxSlot(d, id, fx(name));
    });
    const before = p.mixer.inserts[id]!.fx;
    const moved = before[0]!;
    const q = produce(p, (d) => moveFxSlot(d, id, moved.id, 2));
    const after = q.mixer.inserts[id]!.fx;
    expect(after.map((s) => s.plugin.pluginId)).toEqual(['comp', 'delay', 'eq', 'reverb']);
    expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
    // Untouched slots keep their identity, which is what lets the engine rewire instead of rebuild.
    for (const s of after) expect(before).toContain(s);
    const r = produce(q, (d) => moveFxSlot(d, id, moved.id, -5));
    expect(r.mixer.inserts[id]!.fx[0]).toBe(moved);
  });

  it('enables, mixes, replaces and removes slots', () => {
    const p0 = createEmptyProject();
    const id = insertAt(p0, 1);
    let slot: SlotId | null = null;
    const p = produce(p0, (d) => {
      slot = addFxSlot(d, id, fx('agstudio.delay'));
    });
    const sid = slot as unknown as SlotId;
    const q = produce(p, (d) => {
      setFxSlotEnabled(d, id, sid, false);
      setFxSlotMix(d, id, sid, 1.7);
      replaceFxPlugin(d, id, sid, fx('agstudio.reverb'));
    });
    expect(q.mixer.inserts[id]!.fx[0]).toMatchObject({
      id: sid,
      enabled: false,
      mix: 1,
      plugin: { pluginId: 'agstudio.reverb' },
    });
    expect(produce(q, (d) => setFxSlotMix(d, id, sid, -1)).mixer.inserts[id]!.fx[0]!.mix).toBe(0);
    expect(produce(q, (d) => removeFxSlot(d, id, sid)).mixer.inserts[id]!.fx).toEqual([]);
  });

  it('routes plugin param edits to effect slots', () => {
    const p0 = createEmptyProject();
    const insertId = insertAt(p0, 1);
    let slotId = '' as SlotId;
    const p = produce(p0, (d) => {
      slotId = addFxSlot(d, insertId, fx())!;
    });
    const owner = { kind: 'fx', insertId, slotId } as const;
    const q = produce(p, (d) => setPluginParam(d, owner, 'gain', 6));
    expect(pluginInstanceOf(q, owner)?.params.gain).toBe(6);
    expect(pluginInstanceOf(q, { kind: 'fx', insertId, slotId: 'fx_nope' as SlotId })).toBeUndefined();
  });
});

describe('fader taper', () => {
  it('puts 0 dB at 80% and +5.6 dB at the top', () => {
    expect(faderToGain(UNITY_POSITION)).toBe(1);
    expect(faderToGain(1)).toBeCloseTo(MAX_INSERT_VOLUME, 12);
    expect(20 * Math.log10(faderToGain(1))).toBeCloseTo(5.6, 2);
    expect(faderToGain(0)).toBe(0);
    expect(faderToGain(-1)).toBe(0);
    expect(faderToGain(2)).toBe(MAX_INSERT_VOLUME);
    expect(gainToFader(1)).toBeCloseTo(UNITY_POSITION, 12);
    expect(gainToFader(0)).toBe(0);
    expect(gainToFader(10)).toBe(1);
  });

  it('round-trips positions and gains', () => {
    for (let i = 0; i <= 1000; i++) {
      const pos = i / 1000;
      expect(gainToFader(faderToGain(pos))).toBeCloseTo(pos, 10);
    }
    for (const db of [-90, -60, -24, -12, -6.02, -3, -0.5, 0, 1.5, 5.59]) {
      const gain = Math.pow(10, db / 20);
      expect(faderToGain(gainToFader(gain))).toBeCloseTo(gain, 10);
    }
  });

  it('is monotonic and roughly linear in dB near unity', () => {
    let last = -1;
    for (let i = 0; i <= 200; i++) {
      const g = faderToGain(i / 200);
      expect(g).toBeGreaterThan(last);
      last = g;
    }
    const dbAt = (pos: number) => 20 * Math.log10(faderToGain(pos));
    // About 3 dB per 10% of travel around 0 dB, much coarser near the bottom.
    expect(dbAt(0.8) - dbAt(0.7)).toBeGreaterThan(2.5);
    expect(dbAt(0.8) - dbAt(0.7)).toBeLessThan(4.5);
    expect(dbAt(0.2) - dbAt(0.1)).toBeGreaterThan(15);
  });

  it('formats gains in dB', () => {
    expect(formatGain(1)).toBe('0.0 dB');
    expect(formatGain(0.5)).toBe('-6.0 dB');
    expect(formatGain(MAX_INSERT_VOLUME)).toBe('+5.6 dB');
    expect(formatGain(0)).toBe('-∞ dB');
    expect(formatGain(0.99999)).toBe('0.0 dB');
  });
});

describe('mixer ops under history', () => {
  type Op =
    | { t: 'add'; at: number }
    | { t: 'remove'; i: number }
    | { t: 'move'; i: number; to: number }
    | { t: 'vol'; i: number; v: number }
    | { t: 'solo'; i: number }
    | { t: 'addFx'; i: number; at: number }
    | { t: 'moveFx'; i: number; s: number; to: number }
    | { t: 'removeFx'; i: number; s: number }
    | { t: 'toggleFx'; i: number; s: number };

  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ t: fc.constant('add' as const), at: fc.nat(20) }),
    fc.record({ t: fc.constant('remove' as const), i: fc.nat(20) }),
    fc.record({ t: fc.constant('move' as const), i: fc.nat(20), to: fc.nat(20) }),
    fc.record({ t: fc.constant('vol' as const), i: fc.nat(20), v: fc.double({ min: -1, max: 3, noNaN: true }) }),
    fc.record({ t: fc.constant('solo' as const), i: fc.nat(20) }),
    fc.record({ t: fc.constant('addFx' as const), i: fc.nat(20), at: fc.nat(12) }),
    fc.record({ t: fc.constant('moveFx' as const), i: fc.nat(20), s: fc.nat(12), to: fc.nat(12) }),
    fc.record({ t: fc.constant('removeFx' as const), i: fc.nat(20), s: fc.nat(12) }),
    fc.record({ t: fc.constant('toggleFx' as const), i: fc.nat(20), s: fc.nat(12) }),
  );

  it('keeps the mixer consistent and undoes back to the start', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        let doc = createEmptyProject({ now: new Date(0) });
        const ch = makeInstrumentChannel('Ch', makePluginInstance('x', 1, {}));
        doc = produce(doc, (d) => {
          addChannel(d, ch);
          setChannelProp(d, ch.id, 'output', d.mixer.order[3] as InsertId);
        });
        const initial = doc;
        const history = new History({ get: () => doc, set: (p) => void (doc = p) });
        for (const o of ops) {
          const order = doc.mixer.order;
          const ins = order[o.t === 'add' ? 0 : o.i % order.length] as InsertId;
          const fxs = doc.mixer.inserts[ins]?.fx ?? [];
          const slot = 's' in o && fxs.length ? fxs[o.s % fxs.length]?.id : undefined;
          history.transact(o.t, (d) => {
            switch (o.t) {
              case 'add':
                addInsert(d, makeInsert(newId.insert(), 'New'), o.at);
                break;
              case 'remove':
                removeInsert(d, ins);
                break;
              case 'move':
                moveInsert(d, ins, o.to);
                break;
              case 'vol':
                setInsertProp(d, ins, 'volume', o.v);
                break;
              case 'solo':
                toggleSoloInsert(d, ins);
                break;
              case 'addFx':
                addFxSlot(d, ins, fx(), o.at);
                break;
              case 'moveFx':
                if (slot) moveFxSlot(d, ins, slot, o.to);
                break;
              case 'removeFx':
                if (slot) removeFxSlot(d, ins, slot);
                break;
              case 'toggleFx':
                if (slot) setFxSlotEnabled(d, ins, slot, !fxs.find((s) => s.id === slot)?.enabled);
                break;
            }
          });
          const m = doc.mixer;
          expect(m.order[0]).toBe(MASTER);
          expect([...m.order].sort()).toEqual(Object.keys(m.inserts).sort());
          expect(new Set(m.order).size).toBe(m.order.length);
          for (const i of Object.values(m.inserts)) {
            expect(i.fx.length).toBeLessThanOrEqual(MAX_FX_SLOTS);
            expect(i.volume).toBeGreaterThanOrEqual(0);
            expect(i.volume).toBeLessThanOrEqual(MAX_INSERT_VOLUME);
          }
          const out = doc.channels[ch.id];
          expect(out && out.kind !== 'automation' && m.inserts[out.output]).toBeTruthy();
        }
        while (history.undo());
        expect(doc).toEqual(initial);
      }),
      { numRuns: 60 },
    );
  });
});
