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
    expect(pdc.out(C)).toBe(0);
    expect(pdc.arrival(MASTER)).toBe(300);
    expect(pdc.routePad(B, MASTER)).toBe(0);
    expect(pdc.routePad(C, MASTER)).toBe(300);
    expect(pdc.total).toBe(300);
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
    expect(pdc.routePad(C, MASTER)).toBe(200);
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
    expect(late.keyPad(A, B, 'fx_duck' as SlotId)).toBe(40);
    // A slot that isn't listening (bypassed, or no sidechain input) doesn't hold the bass back.
    const off = new DelayCompensation(ids, edges, (id) =>
      id === A ? [slot('fx_k', 240)] : id === B ? [slot('fx_pre', 40), slot('fx_duck', 0, false)] : [],
    );
    expect(off.arrival(B)).toBe(0);
  });

  it('rounds frames, ignores negative latencies and unknown inserts', () => {
    const edges = [route(A, MASTER), route('ins_x' as InsertId, MASTER), route(D, A)];
    const pdc = new DelayCompensation(ids, edges, (id) => (id === D ? [slot('fx_1', 10.4), slot('fx_2', -5)] : []));
    expect(pdc.out(D)).toBe(10);
    expect(pdc.arrival(A)).toBe(10);
    expect(pdc.total).toBe(10);
  });
});
