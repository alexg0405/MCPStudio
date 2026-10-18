/** FL import, mixer step: inserts with their names, colours, faders, routing and the effects that have a built-in. */
import { makeInsert, masterRoutes } from '../model/defaults';
import { faderToGain } from '../model/fader';
import { newId } from '../model/ids';
import { MASTER, type FxSlot, type Insert, type InsertId } from '../model/types';
import { FLP_INSERT_ENABLED, type FlpInsert } from './flp';
import { effectFor, isVst, pluginLabel } from './flp-import-plugins';
import { clamp, trimName, type FlpImportContext } from './flp-import-types';

/** AGstudio's mixer has the master and this many other tracks at most. */
const MAX_INSERTS = 125;
/** The mixer always has at least this many tracks, as a new project does. */
const MIN_INSERTS = 16;
/** FL's fader scale for insert volume and sends: 16000 is full scale (12800 is 0 dB). */
const FL_INSERT_FADER_MAX = 16000;
/** FL's pan scale for inserts: −6400 (left) … 6400 (right). */
const FL_INSERT_PAN_RANGE = 6400;
/** The loudest send level kept (linear gain). */
const SEND_LEVEL_MAX = 4;

/** What later steps need to know about the mixer that was built. */
export interface MixerImport {
  /** The highest FL insert number that became a track. */
  insertCount: number;
  /** The track for an FL insert number; the master for none, "current" or one that was cut off. */
  insertFor(flInsert: number | undefined): InsertId;
}

/** Builds the mixer into `ctx.project`, counting inserts and effects in the report. */
export function importMixer(ctx: FlpImportContext): MixerImport {
  const { flp, project, report } = ctx;
  const insertCount = countInserts(ctx);
  const insertIds: InsertId[] = [];
  const inserts: Record<InsertId, Insert> = {};
  createInserts(ctx, insertCount, insertIds, inserts);
  createRoutes(ctx, insertCount, insertIds, inserts);
  addEffects(ctx, insertCount, insertIds, inserts);
  project.mixer = { inserts, order: insertIds };
  report.inserts = flp.inserts.filter((_, i) => i > 0 && i <= insertCount && isUsed(ctx, i)).length;
  return {
    insertCount,
    insertFor: (flInsert) =>
      flInsert && flInsert > 0 && flInsert <= insertCount ? (insertIds[flInsert] as InsertId) : MASTER,
  };
}

/** An FL insert counts as used when it has a name or an effect. */
function isUsed(ctx: FlpImportContext, index: number): boolean {
  const insert = ctx.flp.inserts[index];
  return !!insert && (!!insert.name || insert.slots.length > 0);
}

/** How many tracks besides the master: enough for every channel's insert and every used FL insert. */
function countInserts(ctx: FlpImportContext): number {
  const { flp } = ctx;
  const channelInserts = flp.channels.map((c) => c.insert ?? 0).filter((i) => i > 0);
  let count = Math.max(MIN_INSERTS, ...channelInserts);
  for (let i = 1; i < flp.inserts.length; i++) {
    if (isUsed(ctx, i)) count = Math.max(count, i);
  }
  return Math.min(MAX_INSERTS, count);
}

/** One track per FL insert 0…insertCount (0 is the master), with name, colour, volume, pan and mute. */
function createInserts(
  ctx: FlpImportContext,
  insertCount: number,
  insertIds: InsertId[],
  inserts: Record<InsertId, Insert>,
): void {
  const { flp } = ctx;
  // Only trust the "enabled" flag when the file uses it at all (a wrong guess would mute everything).
  const enabledFlagInUse = flp.inserts.some((i) => i.flags !== undefined && (i.flags & FLP_INSERT_ENABLED) !== 0);
  for (let i = 0; i <= insertCount; i++) {
    const fl = flp.inserts[i];
    const id = i === 0 ? MASTER : newId.insert();
    const insert = makeInsert(id, trimName(fl?.name || (i === 0 ? 'Master' : `Insert ${i}`)));
    if (fl?.color && fl.name) insert.color = fl.color;
    if (fl?.volume !== undefined) insert.volume = faderToGain(fl.volume / FL_INSERT_FADER_MAX);
    if (fl?.pan !== undefined) insert.pan = clamp(fl.pan / FL_INSERT_PAN_RANGE, -1, 1);
    if (enabledFlagInUse && fl?.flags !== undefined && i > 0) insert.muted = (fl.flags & FLP_INSERT_ENABLED) === 0;
    insertIds.push(id);
    inserts[id] = insert;
  }
}

/** Routes from FL's routing flags and send levels; a track with none goes to the master. */
function createRoutes(
  ctx: FlpImportContext,
  insertCount: number,
  insertIds: InsertId[],
  inserts: Record<InsertId, Insert>,
): void {
  const { flp } = ctx;
  const routingInUse = flp.inserts.some((i) => i.routing?.some(Boolean));
  for (let i = 1; i <= insertCount; i++) {
    const fl = flp.inserts[i];
    const insert = inserts[insertIds[i] as InsertId] as Insert;
    if (!routingInUse || !fl?.routing) continue;
    const routes: Insert['routes'] = [];
    fl.routing.forEach((isOn, target) => {
      if (!isOn || target === i || target > insertCount) return;
      // Keep the graph acyclic: skip a route whose target already feeds this insert.
      if (reaches(inserts, insertIds[target] as InsertId, insert.id)) return;
      const sendLevel = fl.sends[target];
      routes.push({
        to: insertIds[target] as InsertId,
        level: sendLevel !== undefined ? clamp(faderToGain(sendLevel / FL_INSERT_FADER_MAX), 0, SEND_LEVEL_MAX) : 1,
        pre: false,
      });
    });
    insert.routes = routes.length > 0 ? routes : masterRoutes(insert.id);
  }
}

/** Whether audio from `from` reaches `to` through the routes made so far. */
function reaches(inserts: Record<InsertId, Insert>, from: InsertId, to: InsertId): boolean {
  const seen = new Set<InsertId>();
  const pending = [from];
  while (pending.length > 0) {
    const id = pending.pop() as InsertId;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const route of inserts[id]?.routes ?? []) pending.push(route.to);
  }
  return false;
}

/** The effects with a built-in counterpart go into the track's slots; the rest are listed in the report. */
function addEffects(
  ctx: FlpImportContext,
  insertCount: number,
  insertIds: InsertId[],
  inserts: Record<InsertId, Insert>,
): void {
  const { flp, opts, report } = ctx;
  for (let i = 0; i <= insertCount; i++) {
    const fl: FlpInsert | undefined = flp.inserts[i];
    if (!fl) continue;
    const insert = inserts[insertIds[i] as InsertId] as Insert;
    const slotsInOrder = [...fl.slots].sort((a, b) => a.index - b.index);
    for (const flSlot of slotsInOrder) {
      const effectId = effectFor(flSlot);
      const label = pluginLabel(flSlot);
      if (!effectId || !opts.plugin(effectId)) {
        report.skippedEffects.push({ insert: insert.name, plugin: label });
        continue;
      }
      const slot: FxSlot = {
        id: newId.slot(),
        plugin: ctx.pluginInstance(effectId),
        enabled: flSlot.enabled ?? true,
        mix: 1,
        sidechain: null,
      };
      insert.fx.push(slot);
      report.effects++;
      if (isVst(flSlot)) {
        report.effectStandIns.push({ insert: insert.name, plugin: label, using: ctx.pluginName(effectId) });
      }
    }
  }
}
