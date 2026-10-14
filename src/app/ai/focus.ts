/**
 * The part of the song a request is about ("Ask AI about this part"): a time range, a marker
 * section, some clips or some notes. It is captured when the musician sends and resolved again on
 * every turn (markers move, clips get deleted).
 */
import type { ChannelId, ClipId, MarkerId, NoteId, PatternId, Tick } from '@core/model/types';
import type { Section } from '@core/query/sections';

export type AiFocus =
  | { kind: 'range'; from: Tick; to: Tick; projectId: string }
  | { kind: 'section'; markerId: MarkerId; from: Tick; to: Tick; projectId: string }
  | { kind: 'clips'; clipIds: ClipId[]; projectId: string }
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
}
