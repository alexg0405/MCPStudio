import { describe, expect, it } from 'vitest';
import { MASTER, type InsertId } from '@core/model/types';
import type { RoutingEdge } from '@core/query/routing';
import type { InsertStrip } from './insert-strip';
import { InsertParkingPlanner, type ChannelFeed, type MixSizes, type ParkingView } from './parking-plan';

/** An insert that reports what its effects need, and whether it is parked. */
interface FakeInsert {
  parked: boolean;
  needs: { busy: boolean; tailSec: number };
}

const id = (name: string) => name as InsertId;
const route = (from: string, to: string): RoutingEdge => ({ from: id(from), to: id(to), kind: 'route' });
const sidechain = (from: string, to: string): RoutingEdge => ({ from: id(from), to: id(to), kind: 'sidechain' });

/** A mixer: inserts by name, routing edges, and how many sources each mix has attached (default: just what the plan expects). */
function mixer(inserts: Record<string, Partial<FakeInsert>>, edges: RoutingEdge[], sizes: Record<string, Partial<MixSizes>> = {}) {
  const strips = new Map<InsertId, InsertStrip>();
  for (const [name, fake] of Object.entries(inserts)) {
    const strip = { parked: false, needs: { busy: false, tailSec: 0 }, ...fake } as FakeInsert;
    strips.set(id(name), { get parked() { return strip.parked; }, idleNeeds: () => strip.needs } as unknown as InsertStrip);
  }
  const view: ParkingView = {
    strips,
    edges,
    mixSizes: (insertId) => {
      const routesIn = edges.filter((e) => e.kind === 'route' && e.to === insertId).length;
      return { channelMix: 0, routeMix: 1 + routesIn, ...sizes[insertId] };
    },
  };
  return view;
}

const quiet = (channels = 0): ChannelFeed => ({ attached: channels, silent: true });
const feeds = (entries: Record<string, ChannelFeed>) => new Map(Object.entries(entries).map(([name, feed]) => [id(name), feed]));
const names = (strips: InsertStrip[], view: ParkingView) => strips.map((strip) => [...view.strips].find(([, s]) => s === strip)?.[0]);

describe('InsertParkingPlanner', () => {
  it('parks an insert whose channels are silent and whose effects are asleep', () => {
    const view = mixer({ a: {}, [MASTER]: {} }, [route('a', MASTER)]);
    const plan = new InsertParkingPlanner().plan(view, feeds({ a: quiet(2) }), 10);
    expect(names(plan.park, view)).toEqual([id('a')]);
    expect(plan.unpark).toEqual([]);
  });

  it('never parks the master', () => {
    const view = mixer({ [MASTER]: {} }, []);
    const plan = new InsertParkingPlanner().plan(view, feeds({}), 10);
    expect(plan.park).toEqual([]);
  });

  it('keeps an insert running while a channel plays into it or an effect is awake', () => {
    const view = mixer({ a: {}, b: { needs: { busy: true, tailSec: 0 } }, [MASTER]: {} }, []);
    const plan = new InsertParkingPlanner().plan(view, feeds({ a: { attached: 1, silent: false }, b: quiet(1) }), 10);
    expect(plan.park).toEqual([]);
  });

  it('waits for the tail of effects that cannot say they are asleep, counted from when the input went silent', () => {
    const view = mixer({ a: { needs: { busy: false, tailSec: 3 } }, [MASTER]: {} }, []);
    const planner = new InsertParkingPlanner();
    expect(planner.plan(view, feeds({ a: quiet() }), 10).park).toEqual([]);
    expect(planner.plan(view, feeds({ a: quiet() }), 12.9).park).toEqual([]);
    expect(names(planner.plan(view, feeds({ a: quiet() }), 13).park, view)).toEqual([id('a')]);
    // Sound again, and silence again: the wait starts over.
    planner.plan(view, feeds({ a: { attached: 1, silent: false } }), 14);
    expect(planner.plan(view, feeds({ a: quiet() }), 15).park).toEqual([]);
  });

  it('says it is waiting while an insert with nothing feeding it still has effects awake or ringing', () => {
    const view = mixer({ a: { needs: { busy: true, tailSec: 0 } }, b: { needs: { busy: false, tailSec: 3 } }, c: {}, [MASTER]: {} }, []);
    const planner = new InsertParkingPlanner();
    expect(planner.plan(view, feeds({ a: quiet(), b: quiet(), c: quiet() }), 10).isWaiting).toBe(true);
    const settled = mixer({ c: { parked: true }, [MASTER]: {} }, []);
    expect(new InsertParkingPlanner().plan(settled, feeds({ c: quiet() }), 10).isWaiting).toBe(false);
  });

  it('parks a bus only once everything routed into it is parked', () => {
    const view = mixer({ a: {}, bus: {}, [MASTER]: {} }, [route('a', 'bus'), route('bus', MASTER)]);
    const planner = new InsertParkingPlanner();
    const awakeSource = planner.plan(view, feeds({ a: { attached: 1, silent: false }, bus: quiet() }), 10);
    expect(awakeSource.park).toEqual([]);
    const quietSource = planner.plan(view, feeds({ a: quiet(1), bus: quiet() }), 11);
    expect(names(quietSource.park, view)).toEqual([id('a'), id('bus')]);
  });

  it('counts a sidechain source as something that feeds the listening insert', () => {
    const view = mixer({ kick: {}, bass: {}, [MASTER]: {} }, [sidechain('kick', 'bass')]);
    const plan = new InsertParkingPlanner().plan(view, feeds({ kick: { attached: 1, silent: false }, bass: quiet(1) }), 10);
    expect(names(plan.park, view)).toEqual([]);
  });

  it('does not park an insert that something else feeds (a live input monitor attached to its channel mix)', () => {
    const view = mixer({ a: {}, [MASTER]: {} }, [], { a: { channelMix: 3 } });
    const plan = new InsertParkingPlanner().plan(view, feeds({ a: quiet(2) }), 10);
    expect(plan.park).toEqual([]);
  });

  it('brings a parked insert back when a source wakes, and keeps it parked while all stay quiet', () => {
    const view = mixer({ a: { parked: true }, bus: { parked: true }, [MASTER]: {} }, [route('a', 'bus'), route('bus', MASTER)]);
    const planner = new InsertParkingPlanner();
    expect(planner.plan(view, feeds({ a: quiet(0), bus: quiet() }), 10)).toMatchObject({ park: [], unpark: [] });
    const awake = planner.plan(view, feeds({ a: { attached: 0, silent: false }, bus: quiet() }), 11);
    expect(names(awake.unpark, view)).toEqual([id('a'), id('bus')]);
  });
});
