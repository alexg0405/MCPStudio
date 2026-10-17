import { describe, expect, it } from 'vitest';
import { MASTER, type InsertId, type SlotId } from '@core/model/types';
import type { RoutingEdge } from '@core/query/routing';
import { DelayCompensation, type SlotLatency } from './pdc';

const [A, B, C, D] = ['ins_a', 'ins_b', 'ins_c', 'ins_d'] as InsertId[] as [InsertId, InsertId, InsertId, InsertId];
const ids = [MASTER, A, B, C, D];
const route = (from: InsertId, to: InsertId): RoutingEdge => ({ from, to, kind: 'route' });
const sc = (from: InsertId, to: InsertId, slotId: string): RoutingEdge => ({
  from,
  to,
  kind: 'sidechain',
  slotId: slotId as SlotId,
});
const slot = (id: string, frames: number, keyed = false): SlotLatency => ({ slotId: id as SlotId, frames, keyed });

describe('DelayCompensation', () => {
  it('is all zeros without latent effects', () => {
    const pdc = new DelayCompensation(ids, [route(A, MASTER), route(B, A)], () => []);
    expect(pdc.total).toBe(0);
    expect(pdc.arrival(A)).toBe(0);
    expect(pdc.routePad(B, A)).toBe(0);
  });

  it('pads the shorter of two parallel paths', () => {
    // A sends to B (a latent effect, 300 frames) and to C (dry); both reach the master.
    const edges = [route(A, B), route(A, C), route(B, MASTER), route(C, MASTER)];
    const pdc = new DelayCompensation(ids, edges, (id) => (id === B ? [slot('fx_1', 300)] : []));
    expect(pdc.out(B)).toBe(300);
    expect(pdc.arrival(MASTER)).toBe(300);
    expect(pdc.total).toBe(300);
    // The waiting sits as far upstream as the routing allows: the dry track C is the one scheduled 300 frames late
    // (its channels wait in time, not on a delay line) and the route that feeds it from A holds the rest.
    expect(pdc.arrival(C)).toBe(300);
    expect(pdc.out(C)).toBe(300);
    expect(pdc.routePad(C, MASTER)).toBe(0);
    expect(pdc.routePad(B, MASTER)).toBe(0);
    expect(pdc.routePad(A, B)).toBe(0);
    expect(pdc.routePad(A, C)).toBe(300);
    expect(pdc.arrival(A)).toBe(0);
  });

  it('puts no delay line on a chain where one path limits everything, and waits at the channels instead', () => {
    // A → B → master and C → master; B holds 200 frames of effects. Channels into C are scheduled 200 frames later
    // and nothing else is padded.
    const edges = [route(A, B), route(B, MASTER), route(C, MASTER)];
    const pdc = new DelayCompensation(ids, edges, (id) => (id === B ? [slot('fx_1', 200)] : []));
    expect(pdc.total).toBe(200);
    expect(pdc.arrival(A)).toBe(0);
    expect(pdc.arrival(B)).toBe(0);
    expect(pdc.arrival(C)).toBe(200);
    for (const [from, to] of [
      [A, B],
      [B, MASTER],
      [C, MASTER],
    ] as [InsertId, InsertId][])
      expect(pdc.routePad(from, to)).toBe(0);
  });

  it('a track that feeds nothing heard does not hold anybody back', () => {
    // A routes to the master and to D, which goes nowhere; D must not pin A to the earliest alignment.
    const edges = [route(A, MASTER), route(A, D), route(B, MASTER)];
    const pdc = new DelayCompensation(ids, edges, (id) => (id === B ? [slot('fx_1', 100)] : []));
    expect(pdc.total).toBe(100);
    expect(pdc.arrival(A)).toBe(100);
    expect(pdc.routePad(A, MASTER)).toBe(0);
    expect(pdc.routePad(A, D)).toBe(0);
  });

  it('aligns every route and key whatever the shape of the graph (random graphs)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = (list: InsertId[]) => list[Math.floor(rnd() * list.length)] as InsertId;
    for (let round = 0; round < 300; round++) {
      const n = 3 + Math.floor(rnd() * 5);
      const nodes = Array.from({ length: n }, (_, i) => `ins_${i}` as InsertId);
      const all = [MASTER, ...nodes];
      // Edges only from a lower to a higher index (no loops); some inserts route nowhere.
      const edges: RoutingEdge[] = [];
      nodes.forEach((a, i) => {
        const later = nodes.slice(i + 1);
        if (rnd() < 0.85) edges.push(route(a, later.length && rnd() < 0.6 ? pick(later) : MASTER));
        if (rnd() < 0.3) edges.push(route(a, MASTER));
        if (later.length && rnd() < 0.25) edges.push(sc(a, pick(later), 'fx_k'));
      });
      const frames = new Map(all.map((id) => [id, Math.floor(rnd() * 3) * 50]));
      const slotsOf = (id: InsertId) => [slot('fx_p', frames.get(id) ?? 0), slot('fx_k', 0, true)];
      const pdc = new DelayCompensation(all, edges, slotsOf);
      // The inserts whose sound reaches the master.
      const heard = new Set<InsertId>([MASTER]);
      for (let again = true; again; ) {
        again = false;
        for (const e of edges) {
          if (e.kind !== 'route' || !heard.has(e.to) || heard.has(e.from)) continue;
          heard.add(e.from);
          again = true;
        }
      }
      for (const e of edges) {
        if (e.kind === 'route' && heard.has(e.to)) {
          // Leaving `from` at out(from) plus the delay line, it arrives exactly when `to` expects its input.
          expect(pdc.out(e.from)).toBeLessThanOrEqual(pdc.arrival(e.to));
          expect(pdc.out(e.from) + pdc.routePad(e.from, e.to)).toBe(pdc.arrival(e.to));
        } else if (e.kind === 'sidechain' && e.slotId && heard.has(e.to)) {
          const need = pdc.arrival(e.to) + pdc.before(e.to, e.slotId);
          expect(pdc.out(e.from)).toBeLessThanOrEqual(need);
          expect(pdc.out(e.from) + pdc.keyPad(e.from, e.to, e.slotId)).toBe(need);
        }
      }
      for (const id of heard) {
        expect(pdc.arrival(id)).toBeGreaterThanOrEqual(0);
        expect(pdc.out(id)).toBeLessThanOrEqual(pdc.total);
      }
    }
  });

  it('adds latencies in series and counts the master’s own effects', () => {
    const edges = [route(A, B), route(B, MASTER), route(C, MASTER)];
    const pdc = new DelayCompensation(ids, edges, (id) =>
      id === A
        ? [slot('fx_1', 100), slot('fx_2', 28)]
        : id === B
          ? [slot('fx_3', 72)]
          : id === MASTER
            ? [slot('fx_m', 5)]
            : [],
    );
    expect(pdc.out(A)).toBe(128);
    expect(pdc.out(B)).toBe(200);
    expect(pdc.arrival(MASTER)).toBe(200);
    // C has nothing of its own: its channels are scheduled 200 frames later instead of padding its route.
    expect(pdc.arrival(C)).toBe(200);
    expect(pdc.routePad(C, MASTER)).toBe(0);
    expect(pdc.total).toBe(205);
  });

  it('aligns a sidechain key with the slot it keys', () => {
    // The kick (A) goes through 240 frames of latency; the bass (B) is ducked by slot 2, behind a
    // 40-frame effect. The bass must wait for the key: arrival(B) = 240 − 40 = 200.
    const edges = [route(A, MASTER), route(B, MASTER), sc(A, B, 'fx_duck')];
    const slots = (id: InsertId) =>
      id === A ? [slot('fx_k', 240)] : id === B ? [slot('fx_pre', 40), slot('fx_duck', 0, true)] : [];
    const pdc = new DelayCompensation(ids, edges, slots);
    expect(pdc.arrival(B)).toBe(200);
    expect(pdc.keyPad(A, B, 'fx_duck' as SlotId)).toBe(0);
    expect(pdc.out(B)).toBe(240);
    expect(pdc.routePad(A, MASTER)).toBe(0);
    expect(pdc.routePad(B, MASTER)).toBe(0);
    // An early key is padded instead.
    const late = new DelayCompensation(ids, edges, (id) =>
      id === B ? [slot('fx_pre', 40), slot('fx_duck', 0, true)] : [],
    );
    expect(late.arrival(B)).toBe(0);
    // The key track's own channels wait instead (arrival 40), so its key needs no delay line.
    expect(late.arrival(A)).toBe(40);
    expect(late.keyPad(A, B, 'fx_duck' as SlotId)).toBe(0);
    // A slot that isn't listening (bypassed, or no sidechain input) doesn't hold the bass back.
    const off = new DelayCompensation(ids, edges, (id) =>
      id === A ? [slot('fx_k', 240)] : id === B ? [slot('fx_pre', 40), slot('fx_duck', 0, false)] : [],
    );
    // (B still waits for the master's latency, like any track, but not for the key.)
    expect(off.arrival(B)).toBe(200);
    const noKey = new DelayCompensation(ids, [route(A, MASTER), route(B, MASTER)], (id) =>
      id === A ? [slot('fx_k', 240)] : id === B ? [slot('fx_pre', 40), slot('fx_duck', 0, false)] : [],
    );
    expect(off.arrival(B)).toBe(noKey.arrival(B));
  });

  it('rounds frames, ignores negative latencies and unknown inserts', () => {
    const edges = [route(A, MASTER), route('ins_x' as InsertId, MASTER), route(D, A)];
    const pdc = new DelayCompensation(ids, edges, (id) => (id === D ? [slot('fx_1', 10.4), slot('fx_2', -5)] : []));
    expect(pdc.out(D)).toBe(10);
    expect(pdc.arrival(A)).toBe(10);
    expect(pdc.total).toBe(10);
  });
});
