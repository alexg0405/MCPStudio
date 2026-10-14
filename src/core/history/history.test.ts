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

  it('lists its steps and jumps to any of them (undo history)', () => {
    const t = setup();
    for (const bpm of [100, 110, 120, 130]) {
      t.history.transact(`Tempo ${bpm}`, (d) => setBpm(d, bpm));
      t.tick(2000);
    }
    const ids = t.history.steps().done.map((x) => x.id);
    expect(t.history.steps().done.map((x) => x.label)).toEqual(['Tempo 100', 'Tempo 110', 'Tempo 120', 'Tempo 130']);
    // Back to just after "Tempo 110": two steps undone, listed next-redo first.
    expect(t.history.goTo(ids[1]!)).toBe(2);
    expect(t.doc.transport.bpm).toBe(110);
    expect(t.history.steps().undone.map((x) => x.label)).toEqual(['Tempo 120', 'Tempo 130']);
    // Forward again to "Tempo 130", then all the way back to the start.
    expect(t.history.goTo(ids[3]!)).toBe(2);
    expect(t.doc.transport.bpm).toBe(130);
    expect(t.history.goTo(0)).toBe(4);
    expect(t.history.steps().done).toEqual([]);
    expect(t.history.goTo(12345)).toBe(0);
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

  describe('saved state', () => {
    it('is clean after load and dirty after an edit, clean again after undo', () => {
      const h = setup();
      expect(h.history.status().dirty).toBe(false);
      h.history.transact('Tempo', (d) => setBpm(d, 140));
      expect(h.history.status().dirty).toBe(true);
      h.history.undo();
      expect(h.history.status().dirty).toBe(false);
      h.history.redo();
      expect(h.history.status().dirty).toBe(true);
    });

    it('marks the current state saved and tracks undo/redo around it', () => {
      const h = setup();
      h.history.transact('A', (d) => setBpm(d, 100));
      h.history.transact('B', (d) => setBpm(d, 110));
      h.history.markSaved();
      expect(h.history.status().dirty).toBe(false);
      h.history.undo();
      expect(h.history.status().dirty).toBe(true);
      h.history.redo();
      expect(h.history.status().dirty).toBe(false);
    });

    it('stops merging into the saved entry', () => {
      const h = setup();
      h.history.transact('Tempo', (d) => setBpm(d, 100), { mergeKey: 'bpm' });
      h.history.markSaved();
      h.tick(10);
      h.history.transact('Tempo', (d) => setBpm(d, 101), { mergeKey: 'bpm' });
      expect(h.history.status().dirty).toBe(true);
      h.history.undo();
      expect(h.doc.transport.bpm).toBe(100);
      expect(h.history.status().dirty).toBe(false);
    });

    it('becomes unreachable when the saved state is in the discarded redo stack', () => {
      const h = setup();
      h.history.transact('A', (d) => setBpm(d, 100));
      h.history.markSaved();
      h.history.undo();
      h.history.transact('B', (d) => setBpm(d, 120));
      expect(h.history.status().dirty).toBe(true);
      h.history.undo();
      // Back at the loaded state, which was never saved after "A".
      expect(h.history.status().dirty).toBe(true);
    });

    it('counts an uncommitted gesture as a change', () => {
      const h = setup();
      const ch = channel('Kick');
      h.history.transact('Add', (d) => addChannel(d, ch));
      h.history.markSaved();
      const g = h.history.gesture('Volume');
      expect(h.history.status().dirty).toBe(false);
      g.update((d) => setChannelProp(d, ch.id, 'volume', 0.3));
      expect(h.history.status().dirty).toBe(true);
      g.cancel();
      expect(h.history.status().dirty).toBe(false);
    });

    it('saves a checkpoint taken before edits that happened during the save', () => {
      const h = setup();
      h.history.transact('A', (d) => setBpm(d, 100));
      const cp = h.history.checkpoint();
      h.history.transact('B', (d) => setBpm(d, 110));
      h.history.markSaved(cp);
      expect(h.history.status().dirty).toBe(true);
      h.history.undo();
      expect(h.history.status().dirty).toBe(false);
    });

    it('treats a checkpoint discarded during the save as unreachable', () => {
      const h = setup();
      h.history.transact('A', (d) => setBpm(d, 100));
      const cp = h.history.checkpoint();
      h.history.undo();
      h.history.transact('B', (d) => setBpm(d, 110));
      h.history.markSaved(cp);
      expect(h.history.status().dirty).toBe(true);
      h.history.undo();
      expect(h.history.status().dirty).toBe(true);
    });

    it('loads recovered work as dirty', () => {
      const h = setup();
      h.history.load(h.doc, { dirty: true });
      expect(h.history.status().dirty).toBe(true);
      h.history.markSaved();
      expect(h.history.status().dirty).toBe(false);
    });

    it('keeps the saved state across trimming when it is the new bottom', () => {
      let doc = createEmptyProject({ now: new Date(0) });
      const history = new History({ get: () => doc, set: (p) => void (doc = p) }, { limit: 3 });
      history.transact('1', (d) => setBpm(d, 101));
      history.markSaved();
      history.transact('2', (d) => setBpm(d, 102));
      history.transact('3', (d) => setBpm(d, 103));
      history.transact('4', (d) => setBpm(d, 104)); // drops "1": its result is the new bottom
      for (let i = 0; i < 3; i++) history.undo();
      expect(doc.transport.bpm).toBe(101);
      expect(history.status().dirty).toBe(false);
      for (let i = 0; i < 3; i++) history.redo();
      history.transact('5', (d) => setBpm(d, 105)); // drops "2": the saved state is gone
      for (let i = 0; i < 3; i++) history.undo();
      expect(history.status().dirty).toBe(true);
    });
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
