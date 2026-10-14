/**
 * FL-style routing, relative to the insert selected in the mixer (the "source"): select a track,
 * then right-click (or use the arrow on) another one to send it there, route it only there or let
 * an effect there listen to it (sidechain). Slot menus choose a sidechain source. Choices that would
 * make audio loop are shown disabled with the reason. Every edit is one undo step (app/actions).
 */
import {
  addSidechainEffect,
  removeAllRoutes,
  routeOnly,
  setRoutePre,
  setSidechain,
  toggleRoute,
} from '@app/actions/mixer';
import type { Services } from '@app/services';
import { formatGain } from '@core/model/fader';
import { MASTER, type InsertId, type Project, type SlotId } from '@core/model/types';
import { canRoute, wouldCycle } from '@core/query/routing';
import type { MenuEntry } from '../../controls/ContextMenu';

/** Offered first when a track has nothing that listens to a sidechain yet (then every other such effect). */
const USUAL_SIDECHAIN_EFFECTS = ['agstudio.ducker', 'agstudio.compressor'];

/** Installed effects with a sidechain input, the usual ones first. */
function sidechainEffects(s: Services) {
  const rank = (id: string) => {
    const i = USUAL_SIDECHAIN_EFFECTS.indexOf(id);
    return i < 0 ? USUAL_SIDECHAIN_EFFECTS.length : i;
  };
  return s.plugins
    .list('effect')
    .map((e) => e.def)
    .filter((def) => def.kind === 'effect' && def.sidechain)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

export const LOOP_HINT = 'Not possible: it would create a feedback loop (audio coming back into itself)';

/** The insert routing edits start from: the one selected in the mixer, else the master. */
export function routingSource(s: Services): InsertId {
  const selected = s.session.getState().selectedInsertId;
  return selected && s.doc.getState().project.mixer.inserts[selected] ? selected : MASTER;
}

/** What people call an insert: its name ("Kick", "Reverb bus", "Insert 3"), "Master" for the master. */
export function insertName(project: Project, id: InsertId): string {
  if (id === MASTER) return 'Master';
  const i = project.mixer.order.indexOf(id);
  return project.mixer.inserts[id]?.name ?? (i > 0 ? `Insert ${i}` : 'Insert');
}

/** Where an insert's audio goes, in words: "→ Master", "→ Reverb bus, Master", "→ nowhere (silent)". */
export function routeLine(project: Project, id: InsertId): string {
  if (id === MASTER) return '→ Speakers';
  const routes = project.mixer.inserts[id]?.routes ?? [];
  if (routes.length === 0) return '→ nowhere (silent)';
  return `→ ${routes.map((r) => insertName(project, r.to)).join(', ')}`;
}

/** The same with levels: "Master (0.0 dB), Reverb bus (−6.0 dB, before the fader)". */
export function describeRoutes(project: Project, id: InsertId): string {
  const routes = project.mixer.inserts[id]?.routes ?? [];
  if (routes.length === 0) return 'nowhere: it is silent until you send it somewhere';
  return routes
    .map((r) => `${insertName(project, r.to)} (${formatGain(r.level)}${r.pre ? ', before the fader' : ''})`)
    .join(', ');
}

export interface SidechainSlot {
  slotId: SlotId;
  /** Position in the insert's chain (0-based). */
  index: number;
  name: string;
  source: InsertId | null;
}

/** The insert's slots whose effects listen to a sidechain. */
export function sidechainSlots(s: Services, project: Project, insertId: InsertId): SidechainSlot[] {
  const out: SidechainSlot[] = [];
  project.mixer.inserts[insertId]?.fx.forEach((slot, index) => {
    const def = s.plugins.get(slot.plugin.pluginId);
    if (def?.kind === 'effect' && def.sidechain)
      out.push({ slotId: slot.id, index, name: def.name, source: slot.sidechain });
  });
  return out;
}

/** Strip menu: send, route or sidechain the selected insert to this one; this one's own routing. */
export function stripRoutingItems({ insertId }: { insertId: InsertId }, s: Services): MenuEntry[] {
  const project = s.doc.getState().project;
  const { inserts } = project.mixer;
  const here = inserts[insertId];
  if (!here) return [];
  const items: MenuEntry[] = [];
  const source = routingSource(s);
  const thisName = insertName(project, insertId);
  if (source !== insertId && source !== MASTER && inserts[source]) {
    const from = insertName(project, source);
    const routes = inserts[source].routes;
    const route = routes.find((r) => r.to === insertId);
    const loops = !route && !canRoute(project.mixer, source, insertId);
    const only = routes.length === 1 && route !== undefined;
    items.push(
      { kind: 'label', label: `From “${from}” (selected)` },
      {
        label: 'Send to this track',
        checked: !!route,
        disabled: loops,
        hint: loops
          ? LOOP_HINT
          : route
            ? `“${from}” sends to “${thisName}” at ${formatGain(route.level)}. Click to stop sending`
            : `Also send “${from}” to “${thisName}” (it keeps its other routes)`,
        onSelect: () => toggleRoute(s, source, insertId),
      },
      {
        label: 'Route only to this track',
        disabled: loops || only,
        hint: loops
          ? LOOP_HINT
          : only
            ? `“${from}” already goes only to “${thisName}”`
            : `“${from}” stops going anywhere else and plays only through “${thisName}”`,
        onSelect: () => routeOnly(s, source, insertId),
      },
    );
    if (route)
      items.push({
        label: 'Send before the fader (pre)',
        checked: route.pre,
        hint: route.pre
          ? `The send ignores “${from}”’s fader and pan. Click to send after them (post)`
          : `Take the send before “${from}”’s fader and pan, so the fader doesn’t change it`,
        onSelect: () => setRoutePre(s, source, insertId, !route.pre),
      });
    const scLoops = wouldCycle(inserts, source, insertId);
    items.push({
      kind: 'submenu',
      label: 'Sidechain to this track',
      disabled: scLoops,
      hint: scLoops
        ? LOOP_HINT
        : `Let an effect on “${thisName}” react to “${from}” (e.g. duck a bass whenever the kick hits)`,
      items: () => sidechainTargets(s, project, source, insertId),
    });
  }
  if (insertId !== MASTER) {
    const onlyMaster = here.routes.length === 1 && here.routes[0]?.to === MASTER;
    items.push(
      { kind: 'label', label: 'This track' },
      {
        label: 'Route only to Master',
        disabled: onlyMaster,
        hint: onlyMaster
          ? `“${thisName}” already goes only to the Master`
          : `Remove “${thisName}”’s other sends and play it straight through the Master`,
        onSelect: () => routeOnly(s, insertId, MASTER),
      },
      {
        label: 'Remove all sends',
        disabled: here.routes.length === 0,
        hint:
          here.routes.length === 0
            ? `“${thisName}” has no sends (it is silent)`
            : `Remove every route from “${thisName}”, including the one to the Master: it goes silent`,
        onSelect: () => removeAllRoutes(s, insertId),
      },
    );
  }
  return items;
}

/** Which of `target`'s effects `source` should key; or effects to add keyed by it. */
function sidechainTargets(s: Services, project: Project, source: InsertId, target: InsertId): MenuEntry[] {
  const from = insertName(project, source);
  const slots = sidechainSlots(s, project, target);
  if (slots.length > 0)
    return slots.map((slot) => ({
      label: `${slot.index + 1}. ${slot.name}`,
      checked: slot.source === source,
      hint:
        slot.source === source
          ? `${slot.name} listens to “${from}”. Click to make it listen to its own input again`
          : `${slot.name} (slot ${slot.index + 1}) reacts to “${from}” instead of its own input`,
      onSelect: () => setSidechain(s, target, slot.slotId, slot.source === source ? null : source),
    }));
  const out: MenuEntry[] = [{ kind: 'label', label: 'No effect here listens to a sidechain yet' }];
  for (const def of sidechainEffects(s))
    out.push({
      label: `Add a ${def.name} that reacts to “${from}”`,
      hint: `Adds ${def.name} to “${insertName(project, target)}” with “${from}” as its sidechain${def.description ? `: ${def.description}` : ''}`,
      onSelect: () => addSidechainEffect(s, target, def.id, source),
    });
  return out;
}

/** Slot menu: "Sidechain from ▸" for effects that listen to one. */
export function slotRoutingItems(
  { insertId, slotId }: { insertId: InsertId; slotId: SlotId },
  s: Services,
): MenuEntry[] {
  const project = s.doc.getState().project;
  const { inserts, order } = project.mixer;
  const slot = inserts[insertId]?.fx.find((x) => x.id === slotId);
  const def = slot ? s.plugins.get(slot.plugin.pluginId) : undefined;
  if (!slot || def?.kind !== 'effect' || !def.sidechain) return [];
  const thisName = insertName(project, insertId);
  const sources: MenuEntry[] = [
    {
      label: 'None (its own input)',
      checked: slot.sidechain === null,
      hint: `${def.name} reacts to the audio of “${thisName}” itself`,
      onSelect: () => setSidechain(s, insertId, slotId, null),
    },
    { kind: 'separator' },
  ];
  for (const id of order) {
    if (id === insertId || id === MASTER) continue;
    const name = insertName(project, id);
    const loops = slot.sidechain !== id && wouldCycle(inserts, id, insertId);
    sources.push({
      label: name,
      checked: slot.sidechain === id,
      disabled: loops,
      hint: loops ? LOOP_HINT : `${def.name} reacts to “${name}” (e.g. a kick ducking this track)`,
      onSelect: () => setSidechain(s, insertId, slotId, id),
    });
  }
  return [
    {
      kind: 'submenu',
      label: 'Sidechain from',
      hint: `Choose the track ${def.name} reacts to`,
      items: sources,
    },
  ];
}
