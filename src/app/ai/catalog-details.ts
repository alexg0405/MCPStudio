/**
 * The details of catalog items: what the index leaves out. For a plugin its settings (id, kind, range, unit, default) and
 * presets, for a command what it takes, for a chain its effects in order. They are attached to a request for the items
 * the request most likely needs (`predict.ts`), and returned by the read tools for anything else.
 *
 * The text of one item is the same as the old whole-catalog text (`catalog.ts`), so the model reads one format.
 */
import type { PresetLibrary } from '@app/presets';
import { FAMILY_NOTE } from './catalog';
import type { CatalogItem, CatalogKind } from './catalog-items';
import { hashText } from './text-hash';

/** One item's details and a key that changes when they do (so a conversation that has them is not sent them again). */
export interface ItemDetails {
  item: CatalogItem;
  text: string;
  hasNumberedSettings: boolean;
  key: string;
}

export function itemDetails(item: CatalogItem, presets?: PresetLibrary): ItemDetails {
  const described = item.describe(presets);
  return { item, text: described.text, hasNumberedSettings: described.hasNumberedSettings, key: hashText(described.text) };
}

/** The heading above each kind of details. */
const HEADINGS: Record<CatalogKind, string> = {
  instrument: 'Instruments (settings: kind, range, unit = default; presets):',
  effect: 'Effects (same):',
  tool: 'Piano-roll tools (note_tool action):',
  chain: 'Effect chains (add_chain action):',
  rack: 'Effect racks (add_rack action):',
  'midi-effect': 'MIDI effects (add_midi_effect action; settings: kind, range, unit = default; presets):',
  'midi-chain': 'MIDI effect chains (midi_effects_chain action):',
  command: 'App commands (command action):',
};

const KIND_ORDER: CatalogKind[] = ['instrument', 'effect', 'tool', 'chain', 'rack', 'midi-effect', 'midi-chain', 'command'];

/** The details of several items as one block: a heading per kind, the numbered-settings note once when it applies. */
export function detailsText(details: readonly ItemDetails[]): string {
  const lines: string[] = [];
  if (details.some((d) => d.hasNumberedSettings)) lines.push(FAMILY_NOTE);
  for (const kind of KIND_ORDER) {
    const ofKind = details.filter((d) => d.item.kind === kind);
    if (ofKind.length === 0) continue;
    lines.push(HEADINGS[kind], ...ofKind.map((d) => d.text));
  }
  return lines.join('\n');
}
