/**
 * Finding the chords a project plays: gathers the notes of the harmonic parts (chords, pads, keys, bass, 808) from the song,
 * some clips, some patterns or a stretch of bars, and reads them with `detectSpans`. Melody parts are only used when the
 * project has nothing harmonic to read. Pure, no DOM.
 */
import { isBassRole, isDrumRole, isMusicRole, type Role } from '../arrange/roles';
import { playedNotes } from '../arrange/notes';
import type { ChannelId, ClipId, Note, PatternId, Project, Tick } from '../model/types';
import { patternLength } from '../query/queries';
import { patternPlace } from '../query/chords';
import { ticksPerBar } from '../time/ppq';
import { detectSpans, type DetectedSpan, type HarmonyNote } from './detect';

/** What to read chords from. */
export type HarmonyScope =
  | { kind: 'song' }
  | { kind: 'range'; from: Tick; to: Tick }
  | { kind: 'clips'; clipIds: readonly ClipId[] }
  | { kind: 'patterns'; patternIds: readonly PatternId[] };

/** Roles whose notes say what the chords are. */
const HARMONIC_ROLES: ReadonlySet<Role> = new Set<Role>(['chords', 'pad', 'keys', 'bass', '808']);

const isHarmonic = (role: Role): boolean => HARMONIC_ROLES.has(role);
/** Any pitched part: not a drum, not an effect. */
const isPitched = (role: Role): boolean => !isDrumRole(role) && role !== 'fx' && (isMusicRole(role) || isBassRole(role) || role === 'other');

/** A note read for harmony, with the role of its channel. */
interface ScannedNote extends HarmonyNote {
  role: Role;
}

/** The notes of the patterns, at the place each pattern first plays in the song. */
function patternNotes(project: Project, patternIds: readonly PatternId[], roles: ReadonlyMap<ChannelId, Role>): ScannedNote[] {
  const out: ScannedNote[] = [];
  for (const patternId of patternIds) {
    const pattern = project.patterns[patternId];
    if (!pattern) continue;
    const span = patternLength(pattern, project.transport.timeSig);
    const { songStart } = patternPlace(project, patternId);
    for (const [channelId, notes] of Object.entries(pattern.notes) as [ChannelId, Record<string, Note>][]) {
      const role = roles.get(channelId) ?? 'other';
      for (const note of Object.values(notes ?? {})) {
        if (note.muted || note.tick >= span) continue;
        out.push({ tick: songStart + note.tick, length: Math.min(note.length, span - note.tick), key: note.key, velocity: note.velocity, role });
      }
    }
  }
  return out;
}

/** The notes of the scope with their roles, drums left out. */
function scopeNotes(project: Project, roles: ReadonlyMap<ChannelId, Role>, scope: HarmonyScope): ScannedNote[] {
  if (scope.kind === 'patterns') return patternNotes(project, scope.patternIds, roles);
  const from = scope.kind === 'range' ? scope.from : 0;
  const to = scope.kind === 'range' ? scope.to : Infinity;
  const clipSet = scope.kind === 'clips' ? new Set<ClipId>(scope.clipIds) : null;
  const out: ScannedNote[] = [];
  for (const note of playedNotes(project, from, to)) {
    if (clipSet && !clipSet.has(note.clipId)) continue;
    const role = roles.get(note.channelId) ?? 'other';
    out.push({ tick: note.tick, length: note.length, key: note.key, velocity: note.velocity, role });
  }
  return out;
}

/** Pitched notes of the scope: the harmonic parts, or (with none) every pitched part. */
export function harmonyNotes(project: Project, roles: ReadonlyMap<ChannelId, Role>, scope: HarmonyScope): HarmonyNote[] {
  const pitched = scopeNotes(project, roles, scope).filter((note) => isPitched(note.role));
  const harmonic = pitched.filter((note) => isHarmonic(note.role));
  const chosen = harmonic.length >= 3 ? harmonic : pitched;
  return chosen.map(({ tick, length, key, velocity }) => ({ tick, length, key, velocity }));
}

/** The bounds of a scope in ticks, when it has any (a range, or the clips' span); the notes decide otherwise. */
function scopeBounds(project: Project, scope: HarmonyScope): { from?: Tick; to?: Tick } {
  if (scope.kind === 'range') return { from: scope.from, to: scope.to };
  if (scope.kind !== 'clips') return {};
  const bar = ticksPerBar(project.transport.timeSig);
  const clips = scope.clipIds.map((id) => project.playlist.clips[id]).filter((clip) => !!clip);
  if (clips.length === 0) return {};
  const from = Math.min(...clips.map((clip) => clip.start));
  const to = Math.max(...clips.map((clip) => clip.start + clip.length));
  return { from: Math.floor(from / bar) * bar, to: Math.ceil(to / bar) * bar };
}

/** The chords of a scope, a reading per bar or half bar (song ticks). */
export function detectProjectChords(
  project: Project,
  roles: ReadonlyMap<ChannelId, Role>,
  scope: HarmonyScope,
  options: { resolution?: 'bar' | 'half'; minConfidence?: number } = {},
): DetectedSpan[] {
  const notes = harmonyNotes(project, roles, scope);
  return detectSpans(notes, {
    bar: ticksPerBar(project.transport.timeSig),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
    ...scopeBounds(project, scope),
  });
}
