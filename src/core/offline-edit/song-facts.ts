/**
 * What the offline editor needs to know about the song, read from the project: its bars, its sections, which patterns play
 * where and which channels play what. Plain loops over the stored data; nothing here changes the project.
 */
import { ROLE_GROUP, type Role } from '../arrange/roles';
import { roleFromName } from '../arrange/sections';
import type { Channel, ChannelId, InstrumentChannel, PatternClip, PatternId, Project, Tick } from '../model/types';
import { songSections } from '../query/sections';
import { songLength } from '../query/playlist';
import { patternLength } from '../query/queries';
import { ticksPerBar } from '../time/ppq';
import type { BarRange, EditInput, SectionInfo } from './types';

/** The song as the interpreter reads it. */
export interface SongFacts {
  project: Project;
  roles: ReadonlyMap<ChannelId, Role>;
  /** Ticks in a bar. */
  barTicks: Tick;
  /** The song's length in whole bars (0 when nothing is on the playlist). */
  totalBars: number;
  /** The marker sections in song order. */
  sections: SectionInfo[];
}

/** Reads the facts of the song once per request. */
export function readFacts(input: EditInput): SongFacts {
  const { project } = input;
  const barTicks = ticksPerBar(project.transport.timeSig);
  const totalBars = Math.round(songLength(project) / barTicks);
  const sections = songSections(project).map(
    (section): SectionInfo => ({
      name: section.name,
      role: roleFromName(section.name),
      range: { fromBar: Math.round(section.from / barTicks) + 1, toBar: Math.max(1, Math.round(section.to / barTicks)) },
    }),
  );
  return { project, roles: input.roles, barTicks, totalBars, sections };
}

/** "bars 9–16" or "bar 9". */
export function describeRange(range: BarRange): string {
  return range.fromBar === range.toBar ? `bar ${range.fromBar}` : `bars ${range.fromBar}–${range.toBar}`;
}

/** The song ticks a range covers: from the start of its first bar to the end of its last. */
export function rangeTicks(facts: SongFacts, range: BarRange): { from: Tick; to: Tick } {
  return { from: (range.fromBar - 1) * facts.barTicks, to: range.toBar * facts.barTicks };
}

/** The section a range is exactly, if any (so a message can say "the Hook"). */
export function sectionNamed(facts: SongFacts, range: BarRange): SectionInfo | undefined {
  return facts.sections.find((section) => section.range.fromBar === range.fromBar && section.range.toBar === range.toBar);
}

/** The pattern clips (not muted) that play anywhere inside the ranges. */
export function clipsIn(facts: SongFacts, ranges: readonly BarRange[]): PatternClip[] {
  const spans = ranges.map((range) => rangeTicks(facts, range));
  const found: PatternClip[] = [];
  for (const clip of Object.values(facts.project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.muted) continue;
    if (spans.some((span) => clip.start < span.to && clip.start + clip.length > span.from)) found.push(clip);
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The patterns that play inside the ranges, in the order they first play. */
export function patternsIn(facts: SongFacts, ranges: readonly BarRange[]): PatternId[] {
  const seen = new Set<PatternId>();
  for (const clip of clipsIn(facts, ranges)) seen.add(clip.patternId);
  return [...seen];
}

/** Whether a pattern also plays somewhere outside every one of the ranges. */
export function playsOutside(facts: SongFacts, patternId: PatternId, ranges: readonly BarRange[]): boolean {
  const spans = ranges.map((range) => rangeTicks(facts, range));
  for (const clip of Object.values(facts.project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.patternId !== patternId) continue;
    const isInside = spans.some((span) => clip.start >= span.from && clip.start + clip.length <= span.to);
    if (!isInside) return true;
  }
  return false;
}

/** The pattern a variation was made from (the pattern itself when it is no variation). */
export function sourceOf(project: Project, patternId: PatternId): PatternId {
  return project.patterns[patternId]?.derived?.from ?? patternId;
}

/** A pattern's length in whole bars. */
export function patternBars(facts: SongFacts, patternId: PatternId): number {
  const pattern = facts.project.patterns[patternId];
  if (!pattern) return 0;
  return Math.max(1, Math.round(patternLength(pattern, facts.project.transport.timeSig) / facts.barTicks));
}

/** How many notes a channel has in a pattern. */
export function noteCount(project: Project, patternId: PatternId, channelId: ChannelId): number {
  return Object.keys(project.patterns[patternId]?.notes[channelId] ?? {}).length;
}

/** The roles of one family of channels (the drums, the bass, the chords and leads…). */
export function isRoleIn(facts: SongFacts, channelId: ChannelId, roles: ReadonlySet<Role>): boolean {
  return roles.has(facts.roles.get(channelId) ?? 'other');
}

/** Whether a channel is an instrument (it has notes). */
export function isInstrument(channel: Channel | undefined): channel is InstrumentChannel {
  return channel?.kind === 'instrument';
}

/** The instrument channels with one of these roles, in rack order. */
export function channelsWithRole(facts: SongFacts, roles: ReadonlySet<Role>): InstrumentChannel[] {
  const found: InstrumentChannel[] = [];
  for (const id of facts.project.channelOrder) {
    const channel = facts.project.channels[id];
    if (isInstrument(channel) && roles.has(facts.roles.get(id) ?? 'other')) found.push(channel);
  }
  return found;
}

/** Roles that are hats. */
export const HAT_ROLES: ReadonlySet<Role> = new Set<Role>(['hat', 'open-hat']);
/** Roles that are a kick. */
export const KICK_ROLES: ReadonlySet<Role> = new Set<Role>(['kick']);
/** Roles that hit on the backbeat. */
export const SNARE_ROLES: ReadonlySet<Role> = new Set<Role>(['snare', 'clap', 'rim']);
/** Every drum role, a whole kit on one channel included. */
export const DRUM_ROLES: ReadonlySet<Role> = new Set<Role>((Object.keys(ROLE_GROUP) as Role[]).filter((role) => ROLE_GROUP[role] === 'drums'));
/** Roles of bass lines. */
export const BASS_ROLES: ReadonlySet<Role> = new Set<Role>(['808', 'bass']);
/** Roles of chord parts. */
export const CHORD_ROLES: ReadonlySet<Role> = new Set<Role>(['chords', 'pad', 'keys']);
/** Roles of single-line melodic parts. */
export const LEAD_ROLES: ReadonlySet<Role> = new Set<Role>(['lead', 'pluck', 'arp']);
/** Roles that play pitches (what a key change moves): bass, chords, leads. Voices are audio and move another way. */
export const PITCHED_ROLES: ReadonlySet<Role> = new Set<Role>([...BASS_ROLES, ...CHORD_ROLES, ...LEAD_ROLES]);
