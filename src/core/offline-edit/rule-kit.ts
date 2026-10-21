/**
 * The small pieces the rules share: finding the patterns an edit should write into, the mixer tracks named after a role, and the
 * lines that say what a part is called in a reply.
 */
import type { Role } from '../arrange/roles';
import { ROLE_GROUP } from '../arrange/roles';
import { MASTER, type ChannelId, type Insert, type InsertId, type Note, type PatternId, type Project } from '../model/types';
import { TICKS_PER_STEP } from '../time/ppq';
import { describeRange, noteCount, patternsIn, playsOutside, sourceOf, type SongFacts } from './song-facts';
import type { BarRange, OfflineAction, RuleContext } from './types';

/** A pattern and a channel with notes in it: what a note edit works on. */
export interface PatternPart {
  pattern: PatternId;
  channel: ChannelId;
}

/** Whether exactly one named part is being edited: the app then holds the answer to that span (the focus guard copies shared patterns). */
export function isGuarded(context: RuleContext): boolean {
  return context.guard !== null;
}

/**
 * The patterns (with the channels) a note edit should write into. A named part: the patterns that play there. The whole song:
 * the source of every pattern (its variations follow the source when the answer is committed). Several named parts at once have
 * no guard, so a pattern that also plays outside them is left alone and named in `skipped`.
 */
export function patternParts(context: RuleContext, channels: readonly ChannelId[]): { parts: PatternPart[]; skipped: string[] } {
  const { facts, scope } = context;
  const playing = patternsIn(facts, scope.isNamed ? scope.ranges : [{ fromBar: 1, toBar: Math.max(1, facts.totalBars) }]);
  const candidates = scope.isNamed ? playing : [...new Set(playing.map((id) => sourceOf(facts.project, id)))];
  const parts: PatternPart[] = [];
  const skipped: string[] = [];
  for (const pattern of candidates) {
    const isShared = scope.isNamed && !isGuarded(context) && playsOutside(facts, pattern, scope.ranges);
    for (const channel of channels) {
      if (noteCount(facts.project, pattern, channel) === 0) continue;
      if (isShared) {
        const name = facts.project.patterns[pattern]?.name ?? 'a pattern';
        if (!skipped.includes(name)) skipped.push(name);
        continue;
      }
      parts.push({ pattern, channel });
    }
  }
  return { parts, skipped };
}

/** A line about patterns left alone because they also play outside the parts named. */
export function skippedLine(skipped: readonly string[]): string {
  if (skipped.length === 0) return '';
  const names = skipped.slice(0, 3).map((name) => `“${name}”`).join(', ');
  return ` Left ${names}${skipped.length > 3 ? ' and more' : ''} alone: ${skipped.length === 1 ? 'it also plays' : 'they also play'} outside those parts (ask about one part at a time to change ${skipped.length === 1 ? 'it' : 'them'}).`;
}

/** Whether any pattern playing in the ranges has notes on a channel with one of these roles (a whole kit on one channel counts as drums). */
export function hasPart(facts: SongFacts, ranges: readonly BarRange[], roles: ReadonlySet<Role>): boolean {
  const patterns = patternsIn(facts, ranges);
  for (const [channelId, role] of facts.roles) {
    const counts = roles.has(role) || (role === 'kit' && [...roles].some((wanted) => ROLE_GROUP[wanted] === 'drums'));
    if (!counts) continue;
    if (patterns.some((pattern) => noteCount(facts.project, pattern, channelId) > 0)) return true;
  }
  return false;
}

/** The channels with one of these roles that have notes anywhere in the song (kit channels count for drum roles). */
export function channelsPlaying(facts: SongFacts, roles: ReadonlySet<Role>): ChannelId[] {
  const found: ChannelId[] = [];
  for (const id of facts.project.channelOrder) {
    const role = facts.roles.get(id);
    const channel = facts.project.channels[id];
    if (!role || channel?.kind !== 'instrument') continue;
    const counts = roles.has(role) || (role === 'kit' && [...roles].some((wanted) => ROLE_GROUP[wanted] === 'drums'));
    if (counts) found.push(id);
  }
  return found;
}

/** The notes of a channel in a pattern as `write_notes` and `beat` write them: 1/16 steps, in time order. */
export function notesAsSteps(project: Project, pattern: PatternId, channel: ChannelId): { step: number; len: number; key: number; vel: number }[] {
  const notes = Object.values(project.patterns[pattern]?.notes[channel] ?? {}) as Note[];
  return notes
    .slice()
    .sort((a, b) => a.tick - b.tick || a.key - b.key)
    .map((note) => ({
      step: Math.round((note.tick / TICKS_PER_STEP) * 1000) / 1000,
      len: Math.round((note.length / TICKS_PER_STEP) * 1000) / 1000,
      key: note.key,
      vel: Math.round(note.velocity * 1000) / 1000,
    }));
}

/** The mixer track with one of these names (the role buses are called Kick, Drums, 808, Bass, Chords, Lead, Vocals, FX, Reverb, Delay). */
export function insertNamed(project: Project, ...names: string[]): Insert | undefined {
  const wanted = names.map((name) => name.toLowerCase());
  for (const id of project.mixer.order) {
    if (id === MASTER) continue;
    const insert = project.mixer.inserts[id];
    if (insert && wanted.includes(insert.name.toLowerCase())) return insert;
  }
  return undefined;
}

/** The first effect on a track made by this plugin. */
export function slotOf(insert: Insert | undefined, pluginId: string): Insert['fx'][number] | undefined {
  return insert?.fx.find((slot) => slot.plugin.pluginId === pluginId);
}

/** A linear gain (1 is 0 dB) as dB. */
export const gainToDb = (gain: number): number => (gain <= 0.0001 ? -100 : 20 * Math.log10(gain));

/** A number rounded to one decimal for a message ("+3.5 dB"). */
export const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

/** The id of a mixer track as an action refers to it. */
export const insertRef = (insert: Insert): InsertId => insert.id;

/** One `vary` action over a range of bars. */
export function varyOver(kind: string, range: BarRange, extra: Record<string, unknown> = {}): OfflineAction {
  return { op: 'vary', kind, from_bar: range.fromBar, to_bar: range.toBar, ...extra };
}

/** Where a request that points at a place ("at the end", "into the drop") puts its one bar: the last bar of a part, or the first of it. */
export function lastBar(range: BarRange): number {
  return range.toBar;
}

/** "bars 9–16, 25–32" for a list of ranges. */
export function describeRanges(ranges: readonly BarRange[]): string {
  return ranges.map(describeRange).join(', ');
}

/** The reply for a part the song does not play ("There are no hats in the Hook (bars 17–24)."). */
export function nothingThereReply(what: string, context: RuleContext): string {
  const where = context.scope.isNamed ? `in ${context.scope.label}` : 'in this song';
  return `There ${what.endsWith('s') ? 'are no' : 'is no'} ${what} ${where}, so there is nothing to change.`;
}
