import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { History, type DocChange } from './history';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import type { ChannelId, PatternId, Project } from '../model/types';
import { addChannel, removeChannel, setChannelProp, toggleSoloChannel } from '../ops/channels';
import { setBpm, setStep } from '../ops/notes';

function setup() {
  let doc = createEmptyProject({ now: new Date(0) });
  const changes: DocChange[] = [];
  let clock = 0;
  const history = new History({ get: () => doc, set: (p) => void (doc = p) }, { now: () => clock });
  history.onChange((c) => changes.push(c));
  return {
    history,
    changes,
    get doc() {
      return doc;
    },
    tick: (ms: number) => void (clock += ms),
  };
}

beforeEach(() => {
  setIdSource(seededBytes(42));
});

const channel = (name: string) => makeInstrumentChannel(name, makePluginInstance('test.synth', 1, { level: 0 }));

describe('History', () => {
  it('undoes and redoes a transaction', () => {
    const h = setup();
    const before = h.doc;
    expect(h.history.transact('Tempo', (d) => setBpm(d, 140))).toBe(true);
    expect(h.doc.transport.bpm).toBe(140);
    expect(h.history.status()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'Tempo' });
    h.history.undo();
    expect(h.doc).toEqual(before);
    h.history.redo();
    expect(h.doc.transport.bpm).toBe(140);
  });

  it('ignores recipes that change nothing', () => {
    const h = setup();
    expect(h.history.transact('Noop', () => {})).toBe(false);
    expect(h.history.status().canUndo).toBe(false);
    expect(h.changes).toHaveLength(0);
  });

  it('records a gesture as one entry and emits live updates', () => {
    const h = setup();
    const ch = channel('Kick');
    h.history.transact('Add', (d) => addChannel(d, ch));
    const g = h.history.gesture('Volume');
    for (let v = 0.1; v <= 0.9; v += 0.1) g.update((d) => setChannelProp(d, ch.id, 'volume', v));
    g.commit();
    expect(h.changes.filter((c) => c.origin === 'gesture').length).toBeGreaterThan(5);
    expect(h.doc.channels[ch.id]).toMatchObject({ volume: expect.closeTo(0.9, 5) });
    h.history.undo();
    expect(h.doc.channels[ch.id]?.kind === 'instrument' && h.doc.channels[ch.id]).toMatchObject({ volume: 0.78 });
    // Only "Add" remains.
    expect(h.history.status().undoLabel).toBe('Add');
  });

  it('cancels a gesture back to its start', () => {
    const h = setup();
    const before = h.doc;
    const g = h.history.gesture('Tempo drag');
    g.update((d) => setBpm(d, 150));
    g.update((d) => setBpm(d, 160));
    g.cancel();
    expect(h.doc).toEqual(before);
    expect(h.history.status().canUndo).toBe(false);
  });

  it('merges edits with the same mergeKey inside the window', () => {
    const h = setup();
    h.history.transact('Tempo', (d) => setBpm(d, 131), { mergeKey: 'bpm' });
    h.tick(300);
    h.history.transact('Tempo', (d) => setBpm(d, 132), { mergeKey: 'bpm' });
    h.tick(2000);
    h.history.transact('Tempo', (d) => setBpm(d, 133), { mergeKey: 'bpm' });
    h.history.undo();
    expect(h.doc.transport.bpm).toBe(132);
    h.history.undo();
    expect(h.doc.transport.bpm).toBe(130);
  });

  it('clears redo on a new edit and changes the cursor', () => {
    const h = setup();
    h.history.transact('A', (d) => setBpm(d, 100));
    const saved = h.history.status().cursor;
    h.history.transact('B', (d) => setBpm(d, 110));
    h.history.undo();
    expect(h.history.status().cursor).toBe(saved);
    h.history.transact('C', (d) => setBpm(d, 120));
    expect(h.history.status().canRedo).toBe(false);
    expect(h.history.status().cursor).not.toBe(saved);
  });

  it('commits an open gesture before a new transaction', () => {
    const h = setup();
    const g = h.history.gesture('Drag');
    g.update((d) => setBpm(d, 150));
    h.history.transact('Swing', (d) => {
      d.transport.swing = 0.5;
    });
    expect(g.active).toBe(false);
    h.history.undo();
    expect(h.doc.transport.bpm).toBe(150);
    h.history.undo();
    expect(h.doc.transport.bpm).toBe(130);
  });

  it('random edit sequences fully undo back to the initial document', () => {
    type Op =
      | { t: 'add'; name: string }
      | { t: 'remove'; i: number }
      | { t: 'vol'; i: number; v: number }
      | { t: 'solo'; i: number }
      | { t: 'step'; i: number; step: number; on: boolean }
      | { t: 'bpm'; v: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ t: fc.constant('add' as const), name: fc.string({ maxLength: 8 }) }),
      fc.record({ t: fc.constant('remove' as const), i: fc.nat(5) }),
      fc.record({ t: fc.constant('vol' as const), i: fc.nat(5), v: fc.double({ min: 0, max: 1.25, noNaN: true }) }),
      fc.record({ t: fc.constant('solo' as const), i: fc.nat(5) }),
      fc.record({ t: fc.constant('step' as const), i: fc.nat(5), step: fc.nat(31), on: fc.boolean() }),
      fc.record({ t: fc.constant('bpm' as const), v: fc.double({ min: 10, max: 522, noNaN: true }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const h = setup();
        const initial: Project = h.doc;
        const pid = initial.patternOrder[0] as PatternId;
        const pick = (i: number): ChannelId | undefined =>
          h.doc.channelOrder[i % Math.max(1, h.doc.channelOrder.length)];
        for (const o of ops) {
          h.tick(5000); // never merge
          if (o.t === 'add') h.history.transact('add', (d) => addChannel(d, channel(o.name || 'ch')));
          else if (o.t === 'bpm') h.history.transact('bpm', (d) => setBpm(d, o.v));
          else {
            const id = pick(o.i);
            if (!id) continue;
            if (o.t === 'remove') h.history.transact('rm', (d) => removeChannel(d, id));
            else if (o.t === 'vol') h.history.transact('vol', (d) => setChannelProp(d, id, 'volume', o.v));
            else if (o.t === 'solo') h.history.transact('solo', (d) => toggleSoloChannel(d, id));
            else h.history.transact('step', (d) => setStep(d, pid, id, o.step, o.on, { rootKey: 60 }));
          }
        }
        const final = h.doc;
        while (h.history.undo()) {
          /* undo everything */
        }
        expect(h.doc).toEqual(initial);
        while (h.history.redo()) {
          /* redo everything */
        }
        expect(h.doc).toEqual(final);
      }),
      { numRuns: 60 },
    );
  });
});
