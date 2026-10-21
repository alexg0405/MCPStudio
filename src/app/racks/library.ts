/**
 * Racks you can pick: the factory ones and the ones you saved (kept in this browser, shared as `.agrack` files). The
 * stored shape, the list the browser and the AI show, and the files. Making a rack from a choice is in `build.ts`.
 */
import { downloadBytes, uploadFile } from '@platform/fs-access';
import { readRackFile, writeRackFile, type RackFile } from '@core/rack/file';
import type { Services } from '../services';
import { FACTORY_RACKS, type FactoryRack } from './factory';

/** One of your own racks (kept in this browser). */
export interface UserRack {
  id: string;
  /** Date.now() when saved. */
  saved: number;
  file: RackFile;
}

/** A rack you can put on a track: a factory one or one of yours. */
export interface RackChoice {
  name: string;
  /** What it is for, in a sentence. */
  description: string;
  source: 'factory' | 'user';
  /** Your racks' id. */
  id?: string;
  /** A line about what is inside: how it splits, the branches, the macros. */
  summary: string;
}

const SPLIT_WORDS = { parallel: 'parallel', bands: 'frequency bands', midside: 'mid/side', leftright: 'left/right' } as const;

/** "Parallel: Dry, Squashed. Macros: Blend, Squash". */
export function summaryOf(split: keyof typeof SPLIT_WORDS, branches: readonly string[], macros: readonly string[]): string {
  const named = macros.filter((name) => !/^Macro \d$/.test(name));
  const text = `${SPLIT_WORDS[split][0]?.toUpperCase()}${SPLIT_WORDS[split].slice(1)}: ${branches.join(', ')}`;
  return named.length ? `${text}. Macros: ${named.join(', ')}` : text;
}

function factoryChoice(rack: FactoryRack): RackChoice {
  return {
    name: rack.name,
    description: rack.description,
    source: 'factory',
    summary: summaryOf(rack.split, rack.branches.map((branch) => branch.name), rack.macros.map((macro) => macro.name)),
  };
}

function userChoice(mine: UserRack): RackChoice {
  const rack = mine.file.slot.rack;
  return {
    name: mine.file.name,
    description: mine.file.description ?? 'A rack you saved.',
    source: 'user',
    id: mine.id,
    summary: rack
      ? summaryOf(rack.split, rack.branches.map((branch) => branch.name), rack.macros.map((macro) => macro.name))
      : 'An empty rack',
  };
}

/** Factory racks first, then yours by name. */
export function rackChoices(mine: readonly UserRack[]): RackChoice[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [
    ...FACTORY_RACKS.map(factoryChoice),
    ...[...mine].sort((a, b) => collator.compare(a.file.name, b.file.name)).map(userChoice),
  ];
}

/** A rack by name: exactly (any case), else the only one whose name contains the text. Yours win over a factory one. */
export function findRackChoice(choices: readonly RackChoice[], text: string): RackChoice | undefined {
  const query = text.trim().toLowerCase();
  if (!query) return undefined;
  const exact = [...choices].reverse().find((choice) => choice.name.toLowerCase() === query);
  if (exact) return exact;
  const partial = choices.filter((choice) => choice.name.toLowerCase().includes(query));
  return partial.length === 1 ? partial[0] : undefined;
}

/** A saved rack read back from storage, or null when it is damaged. */
export function userRackOf(raw: unknown): UserRack | null {
  const stored = raw as Partial<UserRack> | null;
  if (!stored || typeof stored.id !== 'string' || stored.file === undefined) return null;
  const read = readRackFile(JSON.stringify(stored.file));
  return read.ok ? { id: stored.id, saved: typeof stored.saved === 'number' ? stored.saved : 0, file: read.file } : null;
}

/** The file name a rack is saved under. */
export function rackFileName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'rack'}.agrack`;
}

/** Downloads a rack as a `.agrack` file. */
export function exportRackFile(file: RackFile): void {
  downloadBytes(rackFileName(`Rack - ${file.name}`), new TextEncoder().encode(writeRackFile(file)), 'application/json');
}

/** Adds the rack in a `.agrack` file's text to your racks (a file opened with the installed app arrives this way). */
export function importRackText(s: Services, text: string): UserRack | null {
  const read = readRackFile(text);
  if (!read.ok) {
    s.session.getState().toast(read.error, 'error');
    return null;
  }
  const saved = s.presets.saveRack(read.file);
  const notes = read.notes.length ? ` (${read.notes.join('; ')})` : '';
  s.session.getState().toast(`Added “${saved.file.name}” to your racks${notes}`);
  return saved;
}

/** Asks for a `.agrack` file and adds it to your racks; null when cancelled or unreadable (the toast says why). */
export async function importRackFile(s: Services): Promise<UserRack | null> {
  const file = await uploadFile('.agrack,application/json');
  return file ? importRackText(s, await file.text()) : null;
}
