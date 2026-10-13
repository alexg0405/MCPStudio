import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { makePluginInstance } from '@core/model/defaults';
import { MASTER, type InsertId, type SlotId } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import type { MenuEntry } from '../../controls/ContextMenu';
import { describeRoutes, LOOP_HINT, routeLine, slotRoutingItems, stripRoutingItems } from './routing';

type Item = Extract<MenuEntry, { label: string; onSelect(): void }>;
type Sub = Extract<MenuEntry, { kind: 'submenu' }>;

function setup() {
  const s = createTestServices();
  const order = s.doc.getState().project.mixer.order;
  const [kick, bass, verb] = [order[1]!, order[2]!, order[3]!] as [InsertId, InsertId, InsertId];
  s.history.transact('names', (d) => {
    d.mixer.inserts[kick]!.name = 'Kick';
    d.mixer.inserts[bass]!.name = 'Bass';
    d.mixer.inserts[verb]!.name = 'Reverb bus';
  });
  const project = () => s.doc.getState().project;
  const item = (entries: MenuEntry[], label: string) =>
    entries.find((e): e is Item => 'label' in e && e.label === label && e.kind !== 'submenu' && e.kind !== 'label');
  const sub = (entries: MenuEntry[], label: string) =>
    entries.find((e): e is Sub => e.kind === 'submenu' && e.label === label);
  return { s, kick, bass, verb, project, item, sub };
}

describe('routing words', () => {
  it('says where each insert goes', () => {
    const { s, kick, verb, project } = setup();
    expect(routeLine(project(), MASTER)).toBe('→ Speakers');
    expect(routeLine(project(), kick)).toBe('→ Master');
    s.history.transact('send', (d) => {
      setRoute(d, kick, verb, { level: 0.5, pre: true });
    });
    expect(routeLine(project(), kick)).toBe('→ Master, Reverb bus');
    expect(describeRoutes(project(), kick)).toBe('Master (0.0 dB), Reverb bus (-6.0 dB, before the fader)');
    s.history.transact('silence', (d) => {
      d.mixer.inserts[kick]!.routes = [];
    });
    expect(routeLine(project(), kick)).toBe('→ nowhere (silent)');
  });
});

describe('strip routing menu', () => {
  it('sends, routes only and removes sends relative to the selected insert, one undo step each', () => {
    const { s, kick, verb, project, item } = setup();
    s.session.getState().selectInsert(kick);
    let menu = stripRoutingItems({ insertId: verb }, s);
    expect(menu[0]).toEqual({ kind: 'label', label: 'From “Kick” (selected)' });
    const send = item(menu, 'Send to this track')!;
    expect(send.checked).toBe(false);
    expect(send.hint).toContain('Also send “Kick” to “Reverb bus”');
    send.onSelect();
    expect(project().mixer.inserts[kick]!.routes.map((r) => r.to)).toEqual([MASTER, verb]);
    expect(s.history.status().undoLabel).toBe('Send Kick to Reverb bus');

    menu = stripRoutingItems({ insertId: verb }, s);
    expect(item(menu, 'Send to this track')!.checked).toBe(true);
    item(menu, 'Send before the fader (pre)')!.onSelect();
    expect(project().mixer.inserts[kick]!.routes[1]!.pre).toBe(true);
    item(stripRoutingItems({ insertId: verb }, s), 'Route only to this track')!.onSelect();
    expect(project().mixer.inserts[kick]!.routes.map((r) => r.to)).toEqual([verb]);
    expect(item(stripRoutingItems({ insertId: verb }, s), 'Route only to this track')!.disabled).toBe(true);
    s.history.undo();
    expect(project().mixer.inserts[kick]!.routes.map((r) => r.to)).toEqual([MASTER, verb]);

    // This track's own routing.
    const own = stripRoutingItems({ insertId: kick }, s);
    expect(own.some((e) => 'label' in e && e.label === 'Send to this track')).toBe(false); // it is the source
    item(own, 'Remove all sends')!.onSelect();
    expect(project().mixer.inserts[kick]!.routes).toEqual([]);
    expect(item(stripRoutingItems({ insertId: kick }, s), 'Remove all sends')!.disabled).toBe(true);
    item(stripRoutingItems({ insertId: kick }, s), 'Route only to Master')!.onSelect();
    expect(project().mixer.inserts[kick]!.routes).toEqual([{ to: MASTER, level: 1, pre: false }]);
  });

  it('disables choices that would loop and says why', () => {
    const { s, kick, bass, item, sub } = setup();
    s.history.transact('bus', (d) => {
      routeOnlyTo(d, kick, bass);
    });
    s.session.getState().selectInsert(bass);
    const menu = stripRoutingItems({ insertId: kick }, s);
    const send = item(menu, 'Send to this track')!;
    expect(send.disabled).toBe(true);
    expect(send.hint).toBe(LOOP_HINT);
    expect(item(menu, 'Route only to this track')!.disabled).toBe(true);
    const sc = sub(menu, 'Sidechain to this track')!;
    expect(sc.disabled).toBe(true);
    expect(sc.hint).toBe(LOOP_HINT);
  });

  it('sidechains to this track: picks one of its sidechain effects, or adds one', () => {
    const { s, kick, bass, project, item, sub } = setup();
    s.session.getState().selectInsert(kick);
    const add = sub(stripRoutingItems({ insertId: bass }, s), 'Sidechain to this track')!;
    const offered = typeof add.items === 'function' ? add.items() : add.items;
    item(offered, 'Add a Ducker that reacts to “Kick”')!.onSelect();
    const slot = project().mixer.inserts[bass]!.fx[0]!;
    expect(slot.plugin.pluginId).toBe('agstudio.ducker');
    expect(slot.sidechain).toBe(kick);
    expect(s.history.status().undoLabel).toBe('Add Ducker reacting to Kick');
    // Now it lists the effect, checked; selecting it again makes it listen to its own input.
    const pick = sub(stripRoutingItems({ insertId: bass }, s), 'Sidechain to this track')!;
    const slots = typeof pick.items === 'function' ? pick.items() : pick.items;
    const ducker = item(slots, '1. Ducker')!;
    expect(ducker.checked).toBe(true);
    ducker.onSelect();
    expect(project().mixer.inserts[bass]!.fx[0]!.sidechain).toBeNull();
  });
});

describe('slot routing menu', () => {
  it('“Sidechain from” lists tracks by name, checks the current one and disables loops', () => {
    const { s, kick, bass, verb, project, item } = setup();
    let slot!: SlotId;
    s.history.transact('setup', (d) => {
      slot = addFxSlot(d, bass, makePluginInstance('agstudio.compressor', 1, {}))!;
      setSlotSidechain(d, bass, slot, kick);
      routeOnlyTo(d, bass, verb); // so the reverb bus can't key the bass
    });
    const [entry] = slotRoutingItems({ insertId: bass, slotId: slot }, s);
    expect(entry).toMatchObject({ kind: 'submenu', label: 'Sidechain from' });
    const sources = (entry as Sub).items as MenuEntry[];
    expect(item(sources, 'None (its own input)')!.checked).toBe(false);
    expect(item(sources, 'Kick')!.checked).toBe(true);
    const fromVerb = item(sources, 'Reverb bus')!;
    expect(fromVerb.disabled).toBe(true);
    expect(fromVerb.hint).toBe(LOOP_HINT);
    expect(sources.some((e) => 'label' in e && e.label === 'Bass')).toBe(false); // not itself
    item(sources, 'None (its own input)')!.onSelect();
    expect(project().mixer.inserts[bass]!.fx[0]!.sidechain).toBeNull();
    expect(s.history.status().undoLabel).toBe('Compressor listens to its own input');
  });

  it('offers nothing for effects without a sidechain input', () => {
    const { s, bass } = setup();
    let slot!: SlotId;
    s.history.transact('eq', (d) => {
      slot = addFxSlot(d, bass, makePluginInstance('agstudio.eq', 1, {}))!;
    });
    expect(slotRoutingItems({ insertId: bass, slotId: slot }, s)).toEqual([]);
  });
});
