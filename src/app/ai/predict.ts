/**
 * Guessing, without a model, which plugins, piano-roll tools, effect chains and commands a request needs, so their
 * details can travel with the request instead of the whole catalog.
 *
 * What it reads: the words of the request (matched like the action search matches what you type, with the producers' words
 * of `predict-words.ts`), and the song as it is: the plugin of the selected channel and of the selected mixer track's effects,
 * the plugins of the channels playing in the part the request is about, plugins whose channel or track the request names
 * ("the lead"), and the plugins and areas (chords, lyrics, launcher…) the song already uses.
 *
 * A word that matches many items (every command has "add" somewhere) counts less than one that matches a few. The result is
 * the best few of each group within a budget; a guess that misses costs a read tool call, never a wrong answer.
 */
import { pluginUsage } from '@core/query/plugin-usage';
import { normalizeText, prepareEntry, wordScore, type PreparedEntry, type Synonyms } from '@core/search/rank';
import type { Channel, Project } from '@core/model/types';
import type { Services } from '../services';
import type { ResolvedFocus } from './focus';
import { catalogItems, type CatalogItem } from './catalog-items';
import { requestWords, synonymsFor } from './predict-words';

/** How many of each group a request's details may carry. */
export interface DetailsBudget {
  /** Instruments, effects, piano-roll tools and MIDI effects together. */
  plugins: number;
  chains: number;
  commands: number;
}

export const DEFAULT_DETAILS_BUDGET: DetailsBudget = { plugins: 8, chains: 2, commands: 30 };

/** What the guess reads besides the words. */
export interface PredictInput {
  request: string;
  /** The part of the song the request is about. */
  focus?: ResolvedFocus | null;
  /** Match the words alone: the song's selection and contents add nothing (the `search_catalog` read tool). */
  ignoreSong?: boolean;
}

/** An item's text score below this is not a match (a stray word in a long hint). */
const MIN_TEXT_SCORE = 4;
/** Boosts from the song, in the same units as a word's match (10 is the start of a name). */
const SELECTED_BOOST = 6;
const FOCUS_BOOST = 3;
const NAMED_CHANNEL_BOOST = 5;
const NAMED_INSERT_BOOST = 3;
const USED_BOOST = 1;
/** A song's chord, lyrics or launcher area makes that area's commands a little likelier. */
const AREA_IN_USE_BOOST = 1.5;
/** The lowest weight a word that matches nearly everything gets; a word that matches one item gets 1. */
const MIN_WORD_WEIGHT = 0.3;
/** Each further request word an item matches adds this share of its score again. */
const COVERAGE_BONUS = 0.3;

/** The command areas a song uses (those have commands the request may well be about). */
function areasInUse(project: Project): Set<string> {
  const areas = new Set<string>();
  if (project.chords && Object.keys(project.chords).length > 0) areas.add('Chords');
  if (project.lyrics && Object.keys(project.lyrics).length > 0) areas.add('Lyrics');
  if (project.launcher) areas.add('Launcher');
  if (project.reference) areas.add('Reference');
  if (project.dj) areas.add('DJ');
  return areas;
}

/** The searchable parts of an item: its name, its kind and category, its description and the words of its id. */
function searchEntry(item: CatalogItem): PreparedEntry {
  const idWords = item.id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[.\-_\s]+/)
    .filter((word) => word !== 'agstudio' && word !== 'user');
  const path = item.kind === 'command' ? [item.category] : [item.kind, item.category];
  return prepareEntry({ label: item.name, path, hint: item.description, keywords: idWords });
}

/** The request's words, and the synonyms they are matched with. */
interface RequestWords {
  words: readonly string[];
  synonyms: Synonyms;
}

/** How much each request word is worth: 1 when it matches a few items of the group, less the more it matches. */
function wordWeights(request: RequestWords, entries: readonly PreparedEntry[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const word of request.words) {
    const matching = entries.filter((entry) => wordScore(entry, word, request.synonyms) > 0).length;
    const share = Math.log(1 + entries.length / Math.max(1, matching)) / Math.log(1 + entries.length);
    weights.set(word, MIN_WORD_WEIGHT + (1 - MIN_WORD_WEIGHT) * share);
  }
  return weights;
}

/** The score of the request's words for one item. */
function textScore(entry: PreparedEntry, request: RequestWords, weights: ReadonlyMap<string, number>): number {
  let total = 0;
  let matched = 0;
  for (const word of request.words) {
    const score = wordScore(entry, word, request.synonyms) * (weights.get(word) ?? 1);
    if (score <= 0) continue;
    total += score;
    matched++;
  }
  return matched > 1 ? total * (1 + COVERAGE_BONUS * (matched - 1)) : total;
}

/** The channel's plugin id, when it is an instrument channel. */
const pluginOfChannel = (channel: Channel | undefined): string | null =>
  channel?.kind === 'instrument' ? channel.plugin.pluginId : null;

/** The ids of the MIDI effects on an instrument channel (they share the plugins' boosts: both are ids in that group). */
const midiEffectsOf = (channel: Channel | undefined): string[] =>
  channel?.kind === 'instrument' ? (channel.midiFx ?? []).map((slot) => slot.effect) : [];

/** The plugin ids of the effects on one mixer track. */
function effectsOfInsert(project: Project, insertId: string | null): string[] {
  const insert = insertId ? project.mixer.inserts[insertId as keyof Project['mixer']['inserts']] : undefined;
  return insert ? insert.fx.map((slot) => slot.plugin.pluginId) : [];
}

/** The plugins of the channels that play in the part of the song the request is about. */
function pluginsInFocus(project: Project, focus: ResolvedFocus | null | undefined): string[] {
  if (!focus) return [];
  const channelIds = new Set<string>();
  if (focus.notes) channelIds.add(focus.notes.channelId);
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.start + clip.length <= focus.from || clip.start >= focus.to) continue;
    const pattern = project.patterns[clip.patternId];
    for (const channelId of Object.keys(pattern?.notes ?? {})) channelIds.add(channelId);
  }
  return [...channelIds]
    .map((channelId) => pluginOfChannel(project.channels[channelId as keyof Project['channels']]))
    .filter((id): id is string => id !== null);
}

/** Whether a request word starts a word of the name ("lead" in "Lead synth"). */
const namesWord = (name: string, words: readonly string[]): boolean => {
  const nameWordsList = normalizeText(name).split(/[^a-z0-9]+/).filter((part) => part.length > 2);
  return words.some((word) => word.length > 2 && nameWordsList.some((part) => part === word || part.startsWith(word)));
};

/** Plugin ids with a boost from what the song and the request say about its channels and tracks. */
function pluginBoosts(services: Services, input: PredictInput, words: readonly string[]): Map<string, number> {
  const project = services.doc.getState().project;
  const session = services.session.getState();
  const boosts = new Map<string, number>();
  const boost = (pluginId: string | null | undefined, amount: number) => {
    if (pluginId) boosts.set(pluginId, (boosts.get(pluginId) ?? 0) + amount);
  };

  for (const pluginId of pluginUsage(project).keys()) boost(pluginId, USED_BOOST);
  if (session.selectedChannelId) {
    const selected = project.channels[session.selectedChannelId];
    boost(pluginOfChannel(selected), SELECTED_BOOST);
    for (const effect of midiEffectsOf(selected)) boost(effect, SELECTED_BOOST);
  }
  for (const pluginId of effectsOfInsert(project, session.selectedInsertId)) boost(pluginId, SELECTED_BOOST);
  for (const pluginId of pluginsInFocus(project, input.focus)) boost(pluginId, FOCUS_BOOST);

  for (const channel of Object.values(project.channels)) {
    if (namesWord(channel.name, words)) boost(pluginOfChannel(channel), NAMED_CHANNEL_BOOST);
  }
  for (const insert of Object.values(project.mixer.inserts)) {
    if (!namesWord(insert.name, words)) continue;
    for (const slot of insert.fx) boost(slot.plugin.pluginId, NAMED_INSERT_BOOST);
  }
  return boosts;
}

/** An item with how well the request (and the song) points at it. */
interface Scored {
  item: CatalogItem;
  /** From the request's words. */
  text: number;
  /** From the song: the selection, the part, the channels the request names, what the song uses. */
  fromSong: number;
}

/** An item is kept only when its text score is at least this share of the group's best, so a weak match does not ride along. */
const RELATIVE_CUTOFF = 0.25;

/**
 * Whether the song points at the item strongly enough to be a guess on its own: the selected channel's plugin, the plugins of
 * the part the request is about, those of a channel or track it names. What the song merely uses is not.
 */
const isPointedAtBySong = (entry: Scored): boolean => entry.fromSong >= FOCUS_BOOST;

/** The best `limit` of a group, best first: what the request's words match well, and what the selection points at. */
function best(group: readonly Scored[], limit: number): CatalogItem[] {
  const strongest = Math.max(0, ...group.map((entry) => entry.text));
  const isWorthKeeping = (entry: Scored) =>
    (entry.text >= MIN_TEXT_SCORE && entry.text >= strongest * RELATIVE_CUTOFF) || isPointedAtBySong(entry);
  return group
    .filter(isWorthKeeping)
    .map((entry) => ({ item: entry.item, score: entry.text + entry.fromSong }))
    .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Scores every item of a group against the request; `fromSong` says how much the song adds to an item. */
function scoreGroup(
  group: readonly CatalogItem[],
  request: RequestWords,
  entries: ReadonlyMap<CatalogItem, PreparedEntry>,
  fromSong: (item: CatalogItem) => number,
): Scored[] {
  const weights = wordWeights(
    request,
    group.map((item) => entries.get(item)!),
  );
  return group.map((item) => ({
    item,
    text: textScore(entries.get(item)!, request, weights),
    fromSong: fromSong(item),
  }));
}

/** The items a request most likely needs, best first within each group, in the order plugins, chains, commands. */
export function predictItems(
  services: Services,
  input: PredictInput,
  budget: DetailsBudget = DEFAULT_DETAILS_BUDGET,
): CatalogItem[] {
  const words = requestWords(input.request);
  const request: RequestWords = { words, synonyms: synonymsFor(words) };
  const items = catalogItems(services);
  const entries = new Map(items.map((item) => [item, searchEntry(item)]));
  const isPluginLike = (item: CatalogItem) =>
    item.kind === 'instrument' || item.kind === 'effect' || item.kind === 'tool' || item.kind === 'midi-effect';
  const plugins = items.filter(isPluginLike);
  const chains = items.filter((item) => item.kind === 'chain' || item.kind === 'midi-chain');
  const commands = items.filter((item) => item.kind === 'command');

  // A search by the request's words alone (the read tool) ignores the song.
  const boosts = input.ignoreSong ? new Map<string, number>() : pluginBoosts(services, input, words);
  const areas = input.ignoreSong ? new Set<string>() : areasInUse(services.doc.getState().project);
  const commandBoost = (item: CatalogItem) => (areas.has(item.category) ? AREA_IN_USE_BOOST : 0);
  return [
    ...best(scoreGroup(plugins, request, entries, (item) => boosts.get(item.id) ?? 0), budget.plugins),
    ...best(scoreGroup(chains, request, entries, () => 0), budget.chains),
    ...best(scoreGroup(commands, request, entries, commandBoost), budget.commands),
  ];
}
