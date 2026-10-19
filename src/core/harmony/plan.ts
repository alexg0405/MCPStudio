/**
 * Turning the chord track into notes: a chord part (voiced chords), a bassline that follows the kick and a melody fitted to
 * the chords. These only plan: they read a project and return notes in pattern ticks, and the callers (the UI's commands and
 * the AI's actions) write them inside one undo step. The project may be an Immer `current()` copy of a draft, so a chord
 * track written earlier in the same AI answer is seen. Pure, no DOM.
 */
import { noteRole, type Role } from '../arrange/roles';
import type { ChannelId, Note, NoteId, PatternId, Project, Tick } from '../model/types';
import { chordTrackEnd, patternChordAt, patternChords, patternPlace, type PatternChord } from '../query/chords';
import { patternLength } from '../query/queries';
import { PPQ, ticksPerBar } from '../time/ppq';
import { makeBassline, type BassNote, type BassStyle } from './bassline';
import { fitMelody } from './fit-melody';
import { compNotes, voiceChords, type CompNote, type CompRhythm, type Spread } from './voicing';

/** The longest part written when a pattern has no length of its own yet (bars). */
export const MAX_NEW_PART_BARS = 64;

/** Where the hand sits: the middle of the chord notes (MIDI keys). */
export const REGISTER_CENTER = { low: 52, mid: 60, high: 72 } as const;
/** Where on the keyboard a chord part sits: low, middle or high; see `REGISTER_CENTER`. */
export type Register = keyof typeof REGISTER_CENTER;

/** Ticks per beat for the project's time signature (a beat is the note value of the bottom number). */
export const beatTicks = (project: Project): Tick => Math.round((PPQ * 4) / project.transport.timeSig.den);

/** Whether the pattern has notes, or plays somewhere in the song (so its length is the musician's, not a blank slate's). */
function hasContent(project: Project, patternId: PatternId): boolean {
  const pattern = project.patterns[patternId];
  if (!pattern) return false;
  const hasNotes = Object.values(pattern.notes).some((notes) => Object.keys(notes ?? {}).length > 0);
  const isPlaced = Object.values(project.playlist.clips).some((clip) => clip.kind === 'pattern' && clip.patternId === patternId);
  return hasNotes || isPlaced || pattern.length !== undefined;
}

/**
 * How long a part written into the pattern is: the bars asked for, else the pattern's own length, else (a blank pattern)
 * the length of the chord track, at most `MAX_NEW_PART_BARS`.
 */
export function partLength(project: Project, patternId: PatternId, bars?: number): Tick {
  const barTicks = ticksPerBar(project.transport.timeSig);
  if (bars !== undefined && bars > 0) return Math.round(bars) * barTicks;
  const pattern = project.patterns[patternId];
  if (pattern && hasContent(project, patternId)) return patternLength(pattern, project.transport.timeSig);
  const fromChords = Math.ceil(chordTrackEnd(project) / barTicks) * barTicks;
  return Math.min(Math.max(fromChords, barTicks), MAX_NEW_PART_BARS * barTicks);
}

/** What a planner returns: the notes, how long the part is and how many chords it covers. */
export interface PartPlan<NoteKind> {
  notes: NoteKind[];
  /** Ticks the pattern must be at least as long as. */
  length: Tick;
  chordCount: number;
}

/**
 * How to write a chord part from the chord track: length in bars, spread, register, rhythm, an optional bass note and
 * the first inversion.
 */
export interface ChordPartOptions {
  bars?: number;
  spread?: Spread;
  register?: Register | number;
  rhythm?: CompRhythm;
  /** Add the chord's bass as a low note under each chord. */
  bass?: boolean;
  /** The first chord's inversion; the rest follow voice leading. */
  inversion?: 'auto' | number;
  velocity?: number;
}

/** Voiced chords for the chord track over the pattern, with voice leading from one chord to the next. */
export function planChordPart(project: Project, patternId: PatternId, options: ChordPartOptions = {}): PartPlan<CompNote> | null {
  const length = partLength(project, patternId, options.bars);
  const chords = patternChords(project, patternId, length);
  if (chords.length === 0) return null;
  const center = typeof options.register === 'number' ? options.register : REGISTER_CENTER[options.register ?? 'mid'];
  const voicings = voiceChords(
    chords.map((entry) => entry.chord),
    {
      center,
      ...(options.spread ? { spread: options.spread } : {}),
      ...(options.bass ? { bass: true } : {}),
      ...(options.inversion !== undefined ? { inversion: options.inversion } : {}),
    },
  );
  const notes = compNotes(chords, voicings, {
    beat: beatTicks(project),
    ...(options.rhythm ? { rhythm: options.rhythm } : {}),
    ...(options.velocity !== undefined ? { velocity: options.velocity } : {}),
  });
  return { notes, length, chordCount: chords.length };
}

/** Where the kick hits, in ticks from the start of a cycle of `cycle` ticks. */
export interface KickPattern {
  kicks: Tick[];
  cycle: Tick;
}

function kickTicksIn(project: Project, patternId: PatternId, roles: ReadonlyMap<ChannelId, Role>): Tick[] {
  const pattern = project.patterns[patternId];
  if (!pattern) return [];
  const ticks = new Set<Tick>();
  for (const [channelId, notes] of Object.entries(pattern.notes) as [ChannelId, Record<string, Note>][]) {
    const channelRole = roles.get(channelId) ?? 'other';
    for (const note of Object.values(notes ?? {})) {
      if (!note.muted && noteRole(channelRole, note.key) === 'kick') ticks.add(note.tick);
    }
  }
  return [...ticks].sort((a, b) => a - b);
}

/**
 * The kick the bass should follow: the pattern's own kick notes; failing those, the kick of the pattern that plays at the
 * same point in the song; failing that, the first pattern with a kick. Null when the project has no kick at all.
 */
export function findKickPattern(project: Project, patternId: PatternId, roles: ReadonlyMap<ChannelId, Role>): KickPattern | null {
  const cycleOf = (id: PatternId): Tick => {
    const pattern = project.patterns[id];
    return pattern ? patternLength(pattern, project.transport.timeSig) : 0;
  };
  const own = kickTicksIn(project, patternId, roles);
  if (own.length) return { kicks: own, cycle: cycleOf(patternId) };
  const { songStart } = patternPlace(project, patternId);
  const sameTime = Object.values(project.playlist.clips)
    .filter((clip) => clip.kind === 'pattern' && !clip.muted && clip.start <= songStart && songStart < clip.start + clip.length && clip.patternId !== patternId)
    .map((clip) => (clip.kind === 'pattern' ? clip.patternId : null))
    .filter((id): id is PatternId => id !== null);
  for (const id of [...sameTime, ...project.patternOrder]) {
    const kicks = kickTicksIn(project, id, roles);
    if (kicks.length) return { kicks, cycle: cycleOf(id) };
  }
  return null;
}

/** How to write a bass part from the chord track: length in bars, style, lowest key and optional seed and velocity. */
export interface BassPartOptions {
  bars?: number;
  style: BassStyle;
  /** The lowest key (default depends on the style). */
  low?: number;
  seed?: number;
  velocity?: number;
}

/** A bassline for the chord track over the pattern; an 808 follows the project's kick. */
export function planBassPart(
  project: Project,
  patternId: PatternId,
  roles: ReadonlyMap<ChannelId, Role>,
  options: BassPartOptions,
): PartPlan<BassNote> | null {
  const length = partLength(project, patternId, options.bars);
  const chords = patternChords(project, patternId, length);
  if (chords.length === 0) return null;
  const barTicks = ticksPerBar(project.transport.timeSig);
  const kick = options.style === '808' ? findKickPattern(project, patternId, roles) : null;
  const notes = makeBassline(
    chords.map((entry) => ({ tick: entry.tick, length: entry.length, chord: entry.chord })),
    {
      style: options.style,
      bar: barTicks,
      beat: beatTicks(project),
      end: length,
      key: project.transport.key ?? null,
      ...(kick ? { kicks: kick.kicks, cycle: kick.cycle } : {}),
      ...(options.low !== undefined ? { low: options.low } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.velocity !== undefined ? { velocity: options.velocity } : {}),
    },
  );
  return { notes, length, chordCount: chords.length };
}

/** How to fit a melody to the chords: how many of the wrong notes to fix (0..1). */
export interface MelodyFitOptions {
  /** 0–1: how many of the notes that are off get fixed (smallest moves first). */
  strength: number;
}

/** The notes that change when a melody is fitted to the chord track: note id and new key. */
export interface MelodyFitPlan {
  changes: { id: NoteId; key: number }[];
  /** How many of the notes were not on a chord or scale tone. */
  off: number;
  noteCount: number;
  /** Notes that sit over no chord at all. */
  withoutChord: number;
}

/** Fits the given notes of a pattern to the chords sounding under them (see `fitMelody`). */
export function planMelodyFit(project: Project, patternId: PatternId, notes: readonly Note[], options: MelodyFitOptions): MelodyFitPlan {
  const pattern = project.patterns[patternId];
  const span = pattern ? patternLength(pattern, project.transport.timeSig) : 0;
  const farthest = Math.max(span, ...notes.map((note) => note.tick + note.length));
  const chords: PatternChord[] = patternChords(project, patternId, farthest);
  const result = fitMelody(notes, {
    chordAt: (tick) => patternChordAt(chords, tick)?.chord ?? null,
    key: project.transport.key ?? null,
    strength: options.strength,
    beat: beatTicks(project),
    beatsPerBar: project.transport.timeSig.num,
  });
  const changes: MelodyFitPlan['changes'] = [];
  notes.forEach((note, index) => {
    const key = result.keys[index] as number;
    if (key !== note.key) changes.push({ id: note.id, key });
  });
  const withoutChord = notes.filter((note) => !patternChordAt(chords, note.tick)).length;
  return { changes, off: result.off, noteCount: notes.length, withoutChord };
}
