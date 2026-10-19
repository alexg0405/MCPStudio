/**
 * Writing a snapshot back into the mixer. Recall writes exact values straight to the tracks (it never goes through a
 * group's links), so recalling and then undoing puts back every value exactly. It only touches what the snapshot
 * knows: a track or effect made after the snapshot is left alone, and one deleted since is skipped.
 */
import type { Draft } from 'immer';
import {
  MASTER,
  type GroupId,
  type InsertId,
  type MixSnapshot,
  type Project,
  type SlotId,
  type SnapshotInsert,
  type SnapshotRouting,
  type SnapshotSlot,
} from '../model/types';
import { setFxSlotEnabled, setFxSlotMix, setInsertProp } from '../ops/mixer';
import { setRoute, setRouteLevel, setSlotSidechain } from '../ops/routing';
import { setVcaLevel } from '../ops/groups';
import { wouldCycle } from '../query/routing';

/** What a recall could not put back (each line is plain words for the musician). */
export interface RecallReport {
  /** Things the snapshot knew that are gone, or that would not fit (a route that would loop). */
  skipped: string[];
}

/** Options of a recall. */
export interface RecallOptions {
  /** Put back the routing too (default: yes when the snapshot has it). */
  routing?: boolean;
}

/** Recalls a snapshot into the draft. Run it inside one `history.transact` so it is one undo step. */
export function recallSnapshot(d: Draft<Project>, snapshot: MixSnapshot, options: RecallOptions = {}): RecallReport {
  const report: RecallReport = { skipped: [] };
  if (snapshot.routing && options.routing !== false) recallRouting(d, snapshot.routing, report);
  for (const [id, saved] of Object.entries(snapshot.inserts) as [InsertId, SnapshotInsert][]) {
    const insert = d.mixer.inserts[id];
    if (!insert) {
      report.skipped.push(`${saved.name} was deleted since`);
      continue;
    }
    setInsertProp(d, id, 'volume', saved.volume);
    setInsertProp(d, id, 'pan', saved.pan);
    setInsertProp(d, id, 'muted', saved.muted);
    setInsertProp(d, id, 'solo', saved.solo);
    for (const [target, level] of Object.entries(saved.sends) as [InsertId, number][]) setRouteLevel(d, id, target, level);
    for (const [slotId, slot] of Object.entries(saved.fx) as [SlotId, SnapshotSlot][]) {
      const live = insert.fx.find((candidate) => candidate.id === slotId);
      if (!live) continue;
      setFxSlotEnabled(d, id, slotId, slot.enabled);
      setFxSlotMix(d, id, slotId, slot.mix);
      // Parameters belong to the effect that was in the slot; a different one keeps its own.
      if (live.plugin.pluginId === slot.plugin) Object.assign(live.plugin.params, slot.params);
    }
  }
  for (const [groupId, level] of Object.entries(snapshot.vca ?? {})) setVcaLevel(d, groupId as GroupId, level);
  return report;
}

/** Puts the routes of a track in the order the snapshot had them (nothing is written when they already are). */
function keepRouteOrder(d: Draft<Project>, id: InsertId, saved: SnapshotRouting): void {
  const order = saved.routes.map((route) => route.to);
  const routes = d.mixer.inserts[id]!.routes;
  const isInOrder = routes.every((route, i) => i === 0 || order.indexOf(routes[i - 1]!.to) <= order.indexOf(route.to));
  if (!isInOrder) routes.sort((a, b) => order.indexOf(a.to) - order.indexOf(b.to));
}

/**
 * Puts back who sends to whom and the sidechain sources. Removals come first for every track, then the additions,
 * each checked for loops against what is in place by then, so a snapshot never makes audio loop.
 */
function recallRouting(d: Draft<Project>, routing: Record<InsertId, SnapshotRouting>, report: RecallReport): void {
  const known = (Object.keys(routing) as InsertId[]).filter((id) => id !== MASTER && d.mixer.inserts[id]);
  for (const id of known) {
    const wanted = new Set(routing[id]!.routes.map((route) => route.to));
    const routes = d.mixer.inserts[id]!.routes;
    for (let i = routes.length - 1; i >= 0; i--) if (!wanted.has(routes[i]!.to)) routes.splice(i, 1);
  }
  for (const id of known) {
    for (const route of routing[id]!.routes) {
      if (!d.mixer.inserts[route.to]) continue;
      const existing = d.mixer.inserts[id]!.routes.find((candidate) => candidate.to === route.to);
      if (!existing && wouldCycle(d.mixer.inserts, id, route.to)) {
        report.skipped.push(`${d.mixer.inserts[id]!.name} → ${d.mixer.inserts[route.to]!.name} would loop`);
        continue;
      }
      setRoute(d, id, route.to, { pre: route.pre });
    }
    keepRouteOrder(d, id, routing[id]!);
  }
  for (const id of known) {
    for (const [slotId, source] of Object.entries(routing[id]!.sidechains) as [SlotId, InsertId | null][]) {
      if (!d.mixer.inserts[id]!.fx.some((slot) => slot.id === slotId)) continue;
      if (source !== null && !d.mixer.inserts[source]) continue;
      if (!setSlotSidechain(d, id, slotId, source)) report.skipped.push(`A sidechain on ${d.mixer.inserts[id]!.name} would loop`);
    }
  }
}
