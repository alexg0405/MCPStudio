/**
 * Reading the mixer's state into a snapshot. Only values are kept: faders, pans, mutes, solos, send levels, the
 * bypass, dry/wet and parameter values of every effect, the VCA levels, and (when asked) the routing. No notes, no
 * arrangement, no plugin state, no samples, so a snapshot stays a few kilobytes even for a big mix.
 */
import { newId } from '../model/ids';
import {
  type FxSlot,
  type GroupId,
  type Insert,
  type InsertId,
  type MixSnapshot,
  type Project,
  type SlotId,
  type SnapshotInsert,
  type SnapshotRouting,
  type SnapshotSlot,
} from '../model/types';

/** The state a snapshot holds, without its id, name and time (what `diffSnapshots` compares). */
export type MixerState = Pick<MixSnapshot, 'inserts' | 'vca' | 'routing'>;

/** What to keep besides the levels. */
export interface CaptureOptions {
  /** Also keep which tracks send to which and the effects' sidechain sources. */
  routing?: boolean;
}

function captureSlot(slot: FxSlot): SnapshotSlot {
  return { plugin: slot.plugin.pluginId, enabled: slot.enabled, mix: slot.mix, params: { ...slot.plugin.params } };
}

function captureInsert(insert: Insert): SnapshotInsert {
  const sends: Record<InsertId, number> = {};
  for (const route of insert.routes) sends[route.to] = route.level;
  const fx: Record<SlotId, SnapshotSlot> = {};
  for (const slot of insert.fx) fx[slot.id] = captureSlot(slot);
  return { name: insert.name, volume: insert.volume, pan: insert.pan, muted: insert.muted, solo: insert.solo, sends, fx };
}

function captureRouting(insert: Insert): SnapshotRouting {
  const sidechains: Record<SlotId, InsertId | null> = {};
  for (const slot of insert.fx) sidechains[slot.id] = slot.sidechain;
  return { routes: insert.routes.map((route) => ({ to: route.to, pre: route.pre })), sidechains };
}

/** The state of the whole mixer, tracks in mixer order. */
export function captureMixerState(project: Project, options: CaptureOptions = {}): MixerState {
  const inserts: MixerState['inserts'] = {};
  const routing: Record<InsertId, SnapshotRouting> = {};
  for (const id of project.mixer.order) {
    const insert = project.mixer.inserts[id];
    if (!insert) continue;
    inserts[id] = captureInsert(insert);
    if (options.routing) routing[id] = captureRouting(insert);
  }
  const vca: Record<GroupId, number> = {};
  for (const group of project.mixer.groups ?? []) if (group.vca !== undefined) vca[group.id] = group.vca;
  return {
    inserts,
    ...(Object.keys(vca).length ? { vca } : {}),
    ...(options.routing ? { routing } : {}),
  };
}

/** A new snapshot of the mixer as it is now. `now` is the time in milliseconds since 1970 (the caller's clock). */
export function captureSnapshot(
  project: Project,
  name: string,
  now: number,
  options: CaptureOptions & { id?: MixSnapshot['id'] } = {},
): MixSnapshot {
  return { id: options.id ?? newId.snapshot(), name, savedAt: now, ...captureMixerState(project, options) };
}
