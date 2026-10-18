import type { ChannelId, ClipId, MarkerId, NoteId, PatternId, Tick } from '@core/model/types';
import type { Section } from '@core/query/sections';

/** Patterns copied for the part by earlier answers: original → the part's own copy (follow-ups edit the copy). */
export type FocusCopies = Record<PatternId, PatternId>;

/** The part of the song a request is about, as captured when the musician sends. */
export type AiFocus =
  | { kind: 'range'; from: Tick; to: Tick; projectId: string; copies?: FocusCopies }
  | { kind: 'section'; markerId: MarkerId; from: Tick; to: Tick; projectId: string; copies?: FocusCopies }
  | { kind: 'clips'; clipIds: ClipId[]; projectId: string; copies?: FocusCopies }
  | { kind: 'notes'; patternId: PatternId; channelId: ChannelId; noteIds: NoteId[]; projectId: string };

/** A focus as it is now in the project. */
export interface ResolvedFocus {
  focus: AiFocus;
  /** Song span (exclusive end); for a notes focus, the pattern's span. */
  from: Tick;
  to: Tick;
  /** "Verse · bars 17–32". */
  label: string;
  /** "bars 17–32", for names like "Drop (bars 37–52)". */
  short: string;
  section: Section | null;
  /** A clips focus: the clips that still exist. */
  clips: ReadonlySet<ClipId> | null;
  notes: { patternId: PatternId; channelId: ChannelId; ids: ReadonlySet<NoteId> } | null;
  /** Copies made for the part earlier that still exist (original → copy). */
  copies: ReadonlyMap<PatternId, PatternId>;
}

/** A time focus (range, section or clips): edits stay inside a span of the song. */
export const isTimeFocus = (focus: AiFocus | null | undefined): boolean => !!focus && focus.kind !== 'notes';

/** "3 clips", "1 note": a count with its noun. */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
