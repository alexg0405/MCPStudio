import { describe, expect, it } from 'vitest';
import { FakeEngine } from '@engine/fake-engine';
import { MASTER, type InsertId, type Project, type SlotId } from '@core/model/types';
import { setFxSlotMix, setInsertProp, toggleSoloInsert } from '@core/ops/mixer';
import { setRouteLevel } from '@core/ops/routing';
import { createServices } from '../services';
import {
  addEffect,
  addMixerInsert,
  addSidechainEffect,
  deleteInsert,
  moveEffectBy,
  moveInsertBy,
  removeAllRoutes,
  removeEffect,
  replaceEffect,
  routeChannel,
  routeOnly,
  setRoutePre,
  setSidechain,
  toggleEffect,
  toggleRoute,
} from './mixer';

/** A project with a kick routed to insert 1, inserts 2 and 3 empty, and a compressor on insert 1. */
function setup() {
  const services = createServices({ platform: 'mac', createEngine: () => new FakeEngine() });
  const project = () => services.doc.getState().project;
  const order = project().mixer.order;
  const [i1, i2, i3] = [order[1], order[2], order[3]] as InsertId[];
  const kick = project().channelOrder[0]!;
  routeChannel(services, kick, i1);
  const comp = addEffect(services, i1, 'agstudio.compressor')!;
  addEffect(services, i1, 'agstudio.eq');
  toggleRoute(services, i1, i2);
  return { services, project, i1, i2, i3, kick, comp };
}

type Setup = ReturnType<typeof setup>;

/** Runs `change`, then checks that one undo returns the exact document from before and one redo the one after. */
function undoable(s: Setup, label: string | RegExp, change: (s: Setup) => void) {
  const before = s.project();
  const stepsBefore = s.services.history.status();
  change(s);
  const after = s.project();
  expect(after, 'the change did something').not.toBe(before);
  expect(s.services.history.status().undoLabel).toMatch(label);
  expect(s.services.history.status().canUndo).toBe(true);
  s.services.history.undo();
  expect(s.project()).toEqual(before);
  // Exactly one step: what was undoable before is still undoable afterwards.
  expect(s.services.history.status().undoLabel).toBe(stepsBefore.undoLabel);
  s.services.history.redo();
  expect(s.project()).toEqual(after);
  s.services.history.undo();
}

describe('every mixer edit undoes in one step', () => {
  it('insert volume, pan, mute, solo, name and colour', () => {
    const s = setup();
    undoable(s, /volume/i, ({ services, i1 }) =>
      services.history.transact('Insert 1 volume', (d) => setInsertProp(d, i1, 'volume', 0.5)),
    );
    undoable(s, /pan/i, ({ services, i1 }) =>
      services.history.transact('Insert 1 pan', (d) => setInsertProp(d, i1, 'pan', -0.4)),
    );
    undoable(s, /mute/i, ({ services, i1 }) =>
      services.history.transact('Mute Insert 1', (d) => setInsertProp(d, i1, 'muted', true)),
    );
    undoable(s, /solo/i, ({ services, i2 }) =>
      services.history.transact('Solo Insert 2', (d) => toggleSoloInsert(d, i2)),
    );
    undoable(s, /rename/i, ({ services, i1 }) =>
      services.history.transact('Rename Insert 1', (d) => setInsertProp(d, i1, 'name', 'Drums')),
    );
    undoable(s, /color/i, ({ services, i1 }) =>
      services.history.transact('Insert 1 color', (d) => setInsertProp(d, i1, 'color', '#ff0000')),
    );
  });

  it('a fader drag is one step however far it moves, and an untouched drag adds none', () => {
    const { services, project, i1 } = setup();
    const before = project();
    const g = services.history.gesture('Insert 1 volume');
    for (const v of [0.9, 0.7, 0.4, 0.2]) g.update((d) => setInsertProp(d, i1, 'volume', v));
    g.commit();
    expect(project().mixer.inserts[i1]!.volume).toBe(0.2);
    expect(services.history.status().undoLabel).toBe('Insert 1 volume');
    services.history.undo();
    expect(project()).toEqual(before);
    expect(services.history.status().undoLabel).not.toBe('Insert 1 volume');
    // A click on the cap that never moved it (begin, then end) leaves no empty entry behind.
    const label = services.history.status().undoLabel;
    services.history.gesture('Insert 1 volume').commit();
    expect(services.history.status().undoLabel).toBe(label);
  });

  it('adding, moving and deleting an insert (with its sends, channels and sidechain)', () => {
    const s = setup();
    undoable(s, /add insert/i, ({ services }) => void addMixerInsert(services));
    undoable(s, /move insert/i, ({ services, i2 }) => moveInsertBy(services, i2, 1));
    // Deleting i1 sends the kick back to the master and drops i1's routes: undo brings all of it back.
    undoable(s, /delete/i, ({ services, i1 }) => deleteInsert(services, i1));
    // A sidechain from i3 into the compressor on i1, then deleting i3 clears the key.
    setSidechain(s.services, s.i1, s.comp, s.i3);
    undoable(s, /delete/i, ({ services, i3 }) => deleteInsert(services, i3));
  });

  it('effects: add, replace, remove, move, bypass, mix', () => {
    const s = setup();
    undoable(s, /add reverb/i, ({ services, i2 }) => void addEffect(services, i2, 'agstudio.reverb'));
    undoable(s, /replace/i, ({ services, i1, comp }) => void replaceEffect(services, i1, comp, 'agstudio.gate'));
    undoable(s, /remove/i, ({ services, i1, comp }) => removeEffect(services, i1, comp));
    undoable(s, /move effect/i, ({ services, i1, comp }) => moveEffectBy(services, i1, comp, 1));
    undoable(s, /bypass/i, ({ services, i1, comp }) => toggleEffect(services, i1, comp));
    undoable(s, /mix/i, ({ services, i1, comp }) =>
      services.history.transact('Effect mix', (d) => setFxSlotMix(d, i1, comp, 0.4)),
    );
  });

  it('routing: send, level, pre/post, route only, remove all, channel output, sidechain', () => {
    const s = setup();
    undoable(s, /send/i, ({ services, i1, i3 }) => void toggleRoute(services, i1, i3));
    undoable(s, /stop sending/i, ({ services, i1, i2 }) => void toggleRoute(services, i1, i2));
    undoable(s, /send/i, ({ services, i1, i2 }) =>
      services.history.transact('Send Insert 1 to Insert 2', (d) => setRouteLevel(d, i1, i2, 0.3)),
    );
    undoable(s, /before the fader/i, ({ services, i1, i2 }) => setRoutePre(services, i1, i2, true));
    undoable(s, /only/i, ({ services, i1, i3 }) => void routeOnly(services, i1, i3));
    undoable(s, /remove all/i, ({ services, i1 }) => removeAllRoutes(services, i1));
    undoable(s, /route/i, ({ services, kick, i3 }) => routeChannel(services, kick, i3));
    undoable(s, /sidechain/i, ({ services, i1, comp, i3 }) => void setSidechain(services, i1, comp, i3));
    undoable(s, /reacting to/i, ({ services, i1, i3 }) => void addSidechainEffect(services, i1, 'agstudio.ducker', i3));
  });

  it('a master effect and the master’s own settings undo too', () => {
    const s = setup();
    let slot: SlotId | null = null;
    undoable(s, /add limiter/i, ({ services }) => {
      slot = addEffect(services, MASTER, 'agstudio.limiter');
    });
    expect(slot).not.toBeNull();
    undoable(s, /volume/i, ({ services }) =>
      services.history.transact('Master volume', (d) => setInsertProp(d, MASTER, 'volume', 0.6)),
    );
  });

  it('keeps the project valid through a long chain of edits and a full undo back to the start', () => {
    const s = setup();
    const start: Project = s.project();
    const { services, i1, i2, i3, kick, comp } = s;
    const startCursor = services.history.status().cursor;
    addMixerInsert(services);
    toggleRoute(services, i2, i3);
    routeChannel(services, kick, i2);
    setSidechain(services, i1, comp, i3);
    deleteInsert(services, i2);
    moveInsertBy(services, i3, -1);
    removeEffect(services, i1, comp);
    // Undo back to where the chain began, however many steps it took.
    while (services.history.status().cursor !== startCursor) services.history.undo();
    expect(s.project()).toEqual(start);
  });
});
