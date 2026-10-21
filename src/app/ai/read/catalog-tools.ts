/**
 * Read tools for the catalog of what Studio can use: the details of plugins, piano-roll tools and effect chains, the
 * details of commands, and a search over all of it. The index in the system prompt is only a table of contents; these
 * are how the model gets a plugin's settings or a command's argument before it uses one, for anything the request's
 * attached details do not cover. Over MCP they are the tools Studio's own AI backends call during a turn.
 */
import type { Services } from '../../services';
import { catalogItems, type CatalogItem, type CatalogKind } from '../catalog-items';
import { detailsText, itemDetails } from '../catalog-details';
import { indexLine } from '../catalog-index';
import { predictItems } from '../predict';
import { str } from '../ops/values';
import * as S from '../schema/parts';
import { tool, type ReadTool, type ToolArgs } from './tool';

/** Most ids one call answers (a call that names more is asked to split). */
const MAX_IDS = 12;
/** Results `search_catalog` returns when no limit is given, and the most it ever returns. */
const DEFAULT_SEARCH_RESULTS = 12;
const MAX_SEARCH_RESULTS = 30;
/** Suggestions given for an id that is not found. */
const SUGGESTIONS = 3;

const ID_LIST = (what: string) => ({ type: 'array', items: { type: 'string' }, description: what });

/** The strings of an array argument (anything else is ignored), without blanks. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

const lowerCase = (text: string) => text.toLowerCase();

/** The item an id or an exact name (any case) names; a chain is found by its name. */
function findItem(items: readonly CatalogItem[], text: string): CatalogItem | undefined {
  const wanted = lowerCase(text);
  return (
    items.find((item) => item.id === text) ??
    items.find((item) => lowerCase(item.id) === wanted) ??
    items.find((item) => lowerCase(item.name) === wanted)
  );
}

/** Up to three items the words of `text` match best, as "id (name)", for a "did you mean". */
function suggestionsFor(services: Services, text: string, kinds: readonly CatalogKind[]): string[] {
  return predictItems(services, { request: text, ignoreSong: true }, { plugins: 6, chains: 3, commands: 6 })
    .filter((item) => kinds.includes(item.kind))
    .slice(0, SUGGESTIONS)
    .map((item) => (item.id === item.name ? item.id : `${item.id} (${item.name})`));
}

/** The details of the items the ids name, and the ids that name nothing (each with a suggestion). */
function detailsOf(services: Services, ids: readonly string[], kinds: readonly CatalogKind[]) {
  const items = catalogItems(services).filter((item) => kinds.includes(item.kind));
  const found: CatalogItem[] = [];
  const notFound: { id: string; did_you_mean?: string[] }[] = [];
  for (const id of ids) {
    const item = findItem(items, id);
    if (item) {
      if (!found.includes(item)) found.push(item);
      continue;
    }
    const suggestions = suggestionsFor(services, id, kinds);
    notFound.push(suggestions.length ? { id, did_you_mean: suggestions } : { id });
  }
  const details = found.map((item) => itemDetails(item, services.presets));
  return {
    ...(details.length ? { details: detailsText(details) } : {}),
    ...(notFound.length ? { not_found: notFound } : {}),
  };
}

const tooMany = (count: number) => ({ error: `${count} ids at once is too many: ask for at most ${MAX_IDS} per call` });

const pluginDetails = tool(
  'get_plugin_details',
  'The details of plugins, piano-roll tools, effect chains, MIDI effects and their chains, for the ids (or exact names) in the catalog index: every setting with its id, kind, range, unit and default, the presets, and for a chain its effects in order. Ask for what you are about to use, up to 12 at a time, instead of guessing a setting id or a range. An id that is not found comes back with the closest matches.',
  { ids: ID_LIST('Plugin ids (e.g. "agstudio.reverb"), piano-roll tool ids or chain names; exact names also work.') },
  (services, args) => {
    const ids = stringList(args.ids);
    if (ids.length === 0) return { error: 'give ids: ["agstudio.reverb", …] from the catalog index' };
    if (ids.length > MAX_IDS) return tooMany(ids.length);
    return detailsOf(services, ids, ['instrument', 'effect', 'tool', 'chain', 'midi-effect', 'midi-chain']);
  },
);

/** `get_plugin_details` needs its ids. */
export const getPluginDetails: ReadTool = { ...pluginDetails, schema: { ...pluginDetails.schema, required: ['ids'] } };

/** The commands of one area: its category ("Piano roll"), or the first part of its ids ("pianoRoll"). */
function commandsOfArea(items: readonly CatalogItem[], area: string): CatalogItem[] {
  const wanted = lowerCase(area);
  return items.filter((item) => lowerCase(item.category) === wanted || lowerCase(item.id).startsWith(`${wanted}.`));
}

export const getCommands: ReadTool = tool(
  'get_commands',
  'The details of app commands for the command action: title, what it does, whether it is a toggle or opens a file dialog (the musician confirms with one click), and the argument it takes. Give ids from the catalog index, or an area (the name before the colon in the index, e.g. "Piano roll") for all of its commands. Ask for what you are about to run instead of guessing an argument.',
  {
    ids: ID_LIST('Command ids, e.g. "file.save" or "audioClip.gain".'),
    area: S.str('An area of the index ("Piano roll", "Transport"), for all of its commands.'),
  },
  (services, args) => {
    const ids = stringList(args.ids);
    const area = str(args.area);
    if (ids.length === 0 && !area) return { error: 'give ids: ["file.save", …] or an area such as "Transport"' };
    if (ids.length > MAX_IDS) return tooMany(ids.length);
    if (!area) return detailsOf(services, ids, ['command']);
    const commands = catalogItems(services).filter((item) => item.kind === 'command');
    const inArea = commandsOfArea(commands, area);
    if (inArea.length === 0) {
      const areas = [...new Set(commands.map((command) => command.category))];
      return { error: `there is no command area "${area}" (areas: ${areas.join(', ')})` };
    }
    return { details: detailsText(inArea.map((item) => itemDetails(item, services.presets))) };
  },
);

/** What `search_catalog`'s `kind` argument means. */
const SEARCH_KINDS: Record<string, readonly CatalogKind[]> = {
  plugin: ['instrument', 'effect'],
  tool: ['tool'],
  chain: ['chain'],
  midi: ['midi-effect', 'midi-chain'],
  command: ['command'],
};

const SEARCH_PROPERTIES = {
  query: S.str('What you are looking for, in a few words.'),
  kind: { type: 'string', enum: Object.keys(SEARCH_KINDS), description: 'Only this kind of thing.' },
  limit: S.int(`How many results (default ${DEFAULT_SEARCH_RESULTS}, at most ${MAX_SEARCH_RESULTS}).`),
};

const search = tool(
  'search_catalog',
  'Finds plugins, piano-roll tools, effect chains, MIDI effects and commands by what they do, with the same matching as the action search: "sidechain", "make harmonies", "export mp3". Returns their lines from the catalog index (id, name, what it does); then ask get_plugin_details or get_commands for the ones you want to use.',
  SEARCH_PROPERTIES,
  (services, args: ToolArgs) => {
    const query = str(args.query);
    if (!query) return { error: 'give a query: what you are looking for' };
    const kinds = typeof args.kind === 'string' ? SEARCH_KINDS[args.kind] : undefined;
    const wanted = typeof args.limit === 'number' ? args.limit : DEFAULT_SEARCH_RESULTS;
    const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.round(wanted)));
    const budget = { plugins: limit, chains: limit, commands: limit };
    const found = predictItems(services, { request: query, ignoreSong: true }, budget)
      .filter((item) => !kinds || kinds.includes(item.kind))
      .slice(0, limit);
    return { results: found.map(indexLine) };
  },
);

/** `search_catalog` needs its query. */
export const searchCatalog: ReadTool = { ...search, schema: { ...search.schema, required: ['query'] } };
