/**
 * The mixer a DJ mix plays through: two deck tracks ("Deck A", "Deck B": EQ Pro with the bass-swap low cut and a
 * high cut at neutral, then a Filter) sending to an "Echo" return, and the master Limiter. Everything is found by
 * name first, so making a mix again reuses what is there (and what the musician changed stays).
 */
import type { Draft } from 'immer';
import type { Deck } from '@core/dj/plan';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type InsertId, type Project, type SlotId } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { setRoute } from '@core/ops/routing';
import { findEmptyInsert } from '@core/query/mixer';
import { defaultValues } from '@agstudio/sdk';
import type { Services } from '../services';
import type { DeckSlots } from './mix-types';

export const EQ_PRO = 'agstudio.eq-pro';
export const FILTER = 'agstudio.filter';
export const DELAY = 'agstudio.delay';
export const LIMITER = 'agstudio.limiter';
export const DECK_NAMES: Record<Deck, string> = { A: 'Deck A', B: 'Deck B' };
export const ECHO_NAME = 'Echo';

/** EQ Pro on a deck: band 1 the bass-swap low cut, band 8 a high cut, both at neutral. */
const DECK_EQ = { b1On: true, b1Type: 'lowCut24', b1Freq: 20, b8On: true, b8Type: 'highCut24', b8Freq: 20000 } as const;
/** The deck's filter at neutral (a low-pass all the way open). */
const DECK_FILTER = { type: 'lowpass', cutoff: 20000, resonance: 0.9 } as const;
/** The echo return: quarter-note ping-pong echoes, thinned and darkened. */
const ECHO_DELAY = { time: '1/4', feedback: 0.5, pingPong: true, mix: 1, lowCut: 200, highCut: 6000 } as const;

/** The insert with this name, else an empty "Insert N" renamed, else a new one. */
function insertNamed(d: Draft<Project>, name: string, changes: string[]): InsertId {
  const project = d as unknown as Project;
  for (const id of d.mixer.order) if (d.mixer.inserts[id]?.name === name && id !== MASTER) return id;
  const empty = findEmptyInsert(project);
  if (empty) {
    d.mixer.inserts[empty]!.name = name;
    changes.push(`Mixer track ${d.mixer.order.indexOf(empty)} is now “${name}”`);
    return empty;
  }
  const id = newId.insert();
  d.mixer.inserts[id] = makeInsert(id, name);
  d.mixer.order.push(id);
  changes.push(`Added the mixer track “${name}”`);
  return id;
}

/** The first slot of a plugin on an insert (set to `params`), else a new one at `index`. Null when the plugin isn't known. */
function slotFor(
  d: Draft<Project>,
  services: Services,
  insertId: InsertId,
  pluginId: string,
  params: Record<string, string | number | boolean>,
  index?: number,
): SlotId | null {
  const insert = d.mixer.inserts[insertId]!;
  const existing = insert.fx.find((slot) => slot.plugin.pluginId === pluginId);
  if (existing) {
    Object.assign(existing.plugin.params, params);
    existing.enabled = true;
    return existing.id;
  }
  const def = services.plugins.get(pluginId);
  if (!def) return null;
  return addFxSlot(d, insertId, makePluginInstance(pluginId, def.version, { ...defaultValues(def.params), ...params }), index);
}

/** Finds or makes the decks, the echo return and the master limiter, all at neutral. */
export function ensureDecks(
  d: Draft<Project>,
  services: Services,
  changes: string[],
): { decks: Record<Deck, DeckSlots | null>; echo: InsertId } {
  const echo = insertNamed(d, ECHO_NAME, changes);
  slotFor(d, services, echo, DELAY, { ...ECHO_DELAY });
  const decks = { A: null, B: null } as Record<Deck, DeckSlots | null>;
  for (const deck of ['A', 'B'] as const) {
    const insertId = insertNamed(d, DECK_NAMES[deck], changes);
    const eq = slotFor(d, services, insertId, EQ_PRO, { ...DECK_EQ }, 0);
    const filter = slotFor(d, services, insertId, FILTER, { ...DECK_FILTER });
    const insert = d.mixer.inserts[insertId]!;
    insert.volume = 1;
    if (!insert.routes.some((route) => route.to === MASTER)) setRoute(d, insertId, MASTER, { level: 1 });
    // The echo send sits at zero; transitions throw into it.
    setRoute(d, insertId, echo, { level: 0, pre: false });
    if (eq && filter) decks[deck] = { insertId, eq, filter };
  }
  addMasterLimiter(d, services, changes);
  return { decks, echo };
}

/** The master gets a Limiter if it has none, so a loud mix doesn't clip. */
function addMasterLimiter(d: Draft<Project>, services: Services, changes: string[]): void {
  const master = d.mixer.inserts[MASTER]!;
  if (master.fx.some((slot) => slot.plugin.pluginId === LIMITER)) return;
  const def = services.plugins.get(LIMITER);
  if (!def) return;
  if (addFxSlot(d, MASTER, makePluginInstance(LIMITER, def.version, defaultValues(def.params)))) {
    changes.push('Added a Limiter to the master');
  }
}
