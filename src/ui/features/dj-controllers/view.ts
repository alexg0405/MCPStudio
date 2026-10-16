/** What the Controllers window shows, as plain data (tested without React). */
import { allTargets, DECK_LETTERS, globalTargets, type DeckLetter, type TargetInfo } from '@core/midi-map/targets';
import { describeInput, type Binding } from '@core/midi-map/types';

export type Section = DeckLetter | 'global';
export const SECTIONS: readonly { id: Section; label: string }[] = [
  ...DECK_LETTERS.map((d) => ({ id: d, label: `Deck ${d}` })),
  { id: 'global', label: 'Mixer & library' },
];

/** The targets of a section grouped as the list shows them (Transport, Platter, Mixer…). */
export function groupedTargets(section: Section): { group: string; targets: TargetInfo[] }[] {
  const list = section === 'global' ? globalTargets() : allTargets().filter((t) => t.deck === section);
  const order: string[] = [];
  const byGroup = new Map<string, TargetInfo[]>();
  for (const t of list) {
    if (!byGroup.has(t.group)) {
      byGroup.set(t.group, []);
      order.push(t.group);
    }
    byGroup.get(t.group)!.push(t);
  }
  return order.map((group) => ({ group, targets: byGroup.get(group)! }));
}

/** The name in a row: "Play / pause" (the deck is in the section title). */
export function rowLabel(t: TargetInfo): string {
  return t.deck ? t.label.replace(/^Deck [A-D]: /, '') : t.label;
}

/** "Ch 1 note 11", with "Shift + " in front for a shifted binding, and "reversed" / "×2" when set. */
export function chipText(b: Binding): string {
  const extras = [b.invert ? 'reversed' : '', b.scale && b.scale !== 1 ? `×${b.scale}` : ''].filter(Boolean).join(', ');
  return `${b.layer ? 'Shift + ' : ''}${describeInput(b.input)}${extras ? ` (${extras})` : ''}`;
}

export const TEST_EMPTY = 'Move a fader, turn a knob or press a button on your controller: every message shows up here with what it did.';

export const NO_DEVICE_TEXT =
  'Plug in your DJ controller, then press “Connect controllers” and allow MIDI in the browser’s prompt. AGstudio listens to it and lights its buttons to match the decks.';

export const NO_DECKS_TEXT = 'The live decks are not available in this build, so controls do nothing yet.';
