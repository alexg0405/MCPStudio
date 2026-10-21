/**
 * The catalog index: a table of contents of everything Studio can use, small enough to sit in the system prompt. One
 * line per plugin (id, name, kind, category, a few words about it, preset count), one per piano-roll tool and effect
 * chain, and one line per command area with each command's id and a very short label.
 *
 * It does not carry settings, ranges, presets or command arguments. Those come as details: for the items a request most
 * likely needs they are attached to the request (`predict.ts`, `catalog-details.ts`), and anything else is fetched with a
 * read tool.
 *
 * The text is deterministic: a fixed order, no timestamps, no ids that vary, nothing about the musician's own presets or
 * chains (those change without an installation changing). So the system prompt it sits in is byte-identical from chat to
 * chat while the installed plugins and commands stay the same, which is what lets the AI's prompt cache reuse it. Its
 * `version` changes exactly when the installed things do.
 */
import type { Services } from '../services';
import { catalogItems, byCodeUnits, type CatalogItem } from './catalog-items';
import { hashText } from './text-hash';

/** A line of the index by `kind:id`, for working out what changed. */
export type IndexLines = ReadonlyMap<string, string>;

export interface CatalogIndex {
  /** The block that goes into the system prompt. */
  text: string;
  /** Changes when the installed plugins, tools, chains or commands do. */
  version: string;
  /** Every item's own line (a command's line says its area), keyed `kind:id`. */
  lines: IndexLines;
}

/** Most words of a plugin's own description kept in its index line. */
const SUMMARY_WORDS = 10;
/** The fewest words a description is cut back to at a comma (a shorter cut says too little). */
const MIN_PHRASE_WORDS = 5;
/** Most words of a command's title kept as its short label. */
const COMMAND_LABEL_WORDS = 3;

/** The key of an item in `CatalogIndex.lines`. */
export const itemKey = (item: Pick<CatalogItem, 'kind' | 'id'>): string => `${item.kind}:${item.id}`;

/** Words a phrase must not end on ("…with amp and"): a cut that lands on one gives them up. */
const DANGLING_WORDS = new Set(
  'a an the and or of to on in at as by for from into with without that than is are'.split(' '),
);

/** A cut-off phrase without the little words and the punctuation it ends on. */
function endCleanly(words: readonly string[]): string {
  const kept = [...words];
  const lastWord = () => (kept[kept.length - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  while (kept.length > 1 && DANGLING_WORDS.has(lastWord())) kept.pop();
  return kept.join(' ').replace(/[\s.;:,–—-]+$/, '');
}

/**
 * The first sentence of a description, without parentheses, cut to `maxWords` words at the last comma or semicolon that fits
 * when there is one, else on a whole phrase: "Sine bass with pitch punch, long decay and drive; overlapping notes glide (mono,
 * legato)." becomes "Sine bass with pitch punch, long decay and drive".
 */
export function summarize(text: string, maxWords: number = SUMMARY_WORDS): string {
  const withoutAsides = text.replace(/\([^)]*\)/g, '').replace(/\s+([,;:.])/g, '$1');
  const firstSentence = withoutAsides.split(/(?<=[.!?])\s+(?=[A-Z“"])/)[0] ?? '';
  const words = firstSentence.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return endCleanly(words);
  const head = words.slice(0, maxWords);
  const lastBreak = head.findLastIndex((word, i) => i >= MIN_PHRASE_WORDS - 1 && /[,;:]$/.test(word));
  return endCleanly(lastBreak >= 0 ? head.slice(0, lastBreak + 1) : head);
}

const nameWords = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "audioClip.sliceAtTransients" gives "slice at transients": the words the command's id already says. */
function wordsOfIdTail(id: string): string {
  const tail = id.slice(id.lastIndexOf('.') + 1);
  return nameWords(tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

/**
 * A very short label for a command: its title without the ellipsis and a leading "Toggle", at most three words, or none
 * when the id already says it (`file.save` "Save").
 */
export function shortCommandLabel(title: string, id: string): string {
  const cleaned = title.replace(/…/g, '').replace(/^(toggle|show or hide)\s+/i, '').replace(/\b(the|a|an)\s+/gi, '').trim();
  const label = endCleanly(cleaned.split(/\s+/).slice(0, COMMAND_LABEL_WORDS));
  return nameWords(label) === wordsOfIdTail(id) ? '' : label;
}

function pluginLine(item: CatalogItem): string {
  const description = summarize(item.description) || `${item.name} ${item.kind}`;
  const presets = `${item.presetCount} preset${item.presetCount === 1 ? '' : 's'}`;
  return [item.id, item.name, item.kind, item.category || '-', description, presets].join(' | ');
}

function toolLine(item: CatalogItem): string {
  return [item.id, item.name, summarize(item.description) || item.name].join(' | ');
}

function chainLine(item: CatalogItem): string {
  return [item.name, summarize(item.description) || item.name].join(' | ');
}

/** One command inside its area's line: `id "label"`, with a star when it takes an argument. */
function commandEntry(item: CatalogItem): string {
  const label = shortCommandLabel(item.name, item.id);
  return `${item.id}${item.takesArgument ? '*' : ''}${label ? ` "${label}"` : ''}`;
}

/** One item's own line, as the index and the search results show it (a command's line starts with its area). */
export function indexLine(item: CatalogItem): string {
  switch (item.kind) {
    case 'instrument':
    case 'effect':
      return pluginLine(item);
    case 'tool':
      return toolLine(item);
    case 'chain':
      return chainLine(item);
    case 'command':
      return `${item.category}: ${commandEntry(item)}`;
  }
}

/** The area's line: `Piano roll: pianoRoll.chop*, pianoRoll.glue "Glue", …`. */
function areaLine(area: string, commands: readonly CatalogItem[]): string {
  return `${area}: ${commands.map(commandEntry).join(', ')}`;
}

/** What the model is told about the index, above the data (it is the same in every chat: it is part of the cached prefix). */
const HOW_TO_USE = [
  'This is the catalog index: a table of contents of the plugins, piano-roll tools, effect chains and app commands you can use.',
  'It has no settings, ranges, presets or arguments. Each request comes with <details> for the items it most likely needs.',
  'For anything else, look it up before you use it: if you can call tools, call get_plugin_details {ids}, get_commands {ids} or',
  'search_catalog {query}; if you cannot (the request says so), answer with a query action for the same tool and use the result in the next turn.',
  'Never guess a setting id, a range, a unit or a command argument.',
].join(' ');

function section(title: string, lines: readonly string[]): string[] {
  return lines.length ? ['', title, ...lines] : [];
}

/** Items of one kind, in the catalog's fixed order, limited to the ones in the index. */
const ofKind = (items: readonly CatalogItem[], kind: CatalogItem['kind']): CatalogItem[] =>
  items.filter((item) => item.kind === kind && item.isInIndex);

/** The command areas in code-unit order, each with its commands. */
function commandAreas(commands: readonly CatalogItem[]): Map<string, CatalogItem[]> {
  const areas = new Map<string, CatalogItem[]>();
  for (const command of commands) areas.set(command.category, [...(areas.get(command.category) ?? []), command]);
  return new Map([...areas].sort(([a], [b]) => byCodeUnits(a, b)));
}

/** The index of what is installed right now. */
export function catalogIndex(services: Services): CatalogIndex {
  const items = catalogItems(services);
  const instruments = ofKind(items, 'instrument');
  const effects = ofKind(items, 'effect');
  const tools = ofKind(items, 'tool');
  const chains = ofKind(items, 'chain');
  const commands = ofKind(items, 'command');
  const areas = commandAreas(commands);

  const data = [
    ...section('Instruments (id | name | kind | category | what it does | presets):', instruments.map(pluginLine)),
    ...section('Effects (same columns; up to 10 per mixer track):', effects.map(pluginLine)),
    ...section('Piano-roll tools (note_tool action; id | name | what it does):', tools.map(toolLine)),
    ...section(
      'Effect chains (add_chain action; name | what it is for; the musician’s own chains are in get_chains):',
      chains.map(chainLine),
    ),
    ...section(
      'App commands by area (command action; id, "label", * = takes an argument):',
      [...areas].map(([area, inArea]) => areaLine(area, inArea)),
    ),
  ].join('\n');
  const version = hashText(data);

  const counts = `${instruments.length + effects.length} plugins, ${tools.length} piano-roll tools, ${chains.length} chains, ${commands.length} commands`;
  const text = `${HOW_TO_USE}\nCatalog index v${version}: ${counts}.\n${data}`;

  const lines = new Map<string, string>();
  for (const item of [...instruments, ...effects, ...tools, ...chains, ...commands]) lines.set(itemKey(item), indexLine(item));
  return { text, version, lines };
}

/** What changed between two indexes, as the lines a conversation has to be told (nothing when they are the same). */
export interface IndexChange {
  added: string[];
  changed: string[];
  /** Keys (`kind:id`) of what is gone. */
  removed: string[];
}

export function diffIndex(before: IndexLines, after: IndexLines): IndexChange {
  const change: IndexChange = { added: [], changed: [], removed: [] };
  for (const [key, line] of after) {
    const old = before.get(key);
    if (old === undefined) change.added.push(line);
    else if (old !== line) change.changed.push(line);
  }
  for (const key of before.keys()) if (!after.has(key)) change.removed.push(key);
  return change;
}
