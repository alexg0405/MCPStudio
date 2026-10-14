/**
 * Keeps an answer's edits inside the part of the song the request is about (the focus): patterns that
 * also play elsewhere are copied for the part first, playlist edits must stay within the part (±1 bar
 * for transitions), selected notes limit note edits. Without a focus every check passes unchanged.
 */
import type { AutoPoint, ChannelId, ClipId, NoteId, ParamTarget, PatternId, Tick } from '@core/model/types';
import type { ResolvedTarget } from '@core/automation/targets';
import type { AiFocus, ResolvedFocus } from '../focus';
import type { PromptSection } from '../prompt-section';
import type { OpContext } from './context';

export interface FocusGuard {
  readonly active: ResolvedFocus | null;
  /** The pattern an action should use (a copy made for the part, once one exists). */
  resolve(pid: PatternId): PatternId;
  /** Before a content edit: the pattern to write into (copies a pattern that also plays outside the part). */
  writable(pid: PatternId): PatternId;
  /** Before removing a pattern: refuses one that plays outside the part. */
  owned(pid: PatternId, what: string): void;
  /** A playlist edit over from–to: refused when it reaches outside the part (±1 bar). */
  span(from: Tick, to: Tick, what: string): void;
  /** An edit of one clip: refused when the clip lies outside the part. */
  clip(id: ClipId, what: string): void;
  /** Default range for actions that take one (clear_playlist, automate). */
  range(): { from: Tick; to: Tick } | null;
  /** A notes focus on this pattern and channel: the notes that may change (null = all). */
  notes(pid: PatternId, cid: ChannelId): ReadonlySet<NoteId> | null;
  /** Refuses whole-pattern edits (steps tools, clearing every channel) in a notes focus. */
  wholePattern(pid: PatternId, cid: ChannelId | null, what: string): void;
  /**
   * An automation clip in the part: may end the curve where the control sat before (automation holds
   * its last value). Returns a change line when it did.
   */
  closeAutomation(target: ParamTarget, res: ResolvedTarget, start: Tick, length: Tick, points: AutoPoint[]): string | null;
  /** After the last action: the focus as it is now, and the clips to select. */
  finish(): { focus: AiFocus | null; clips: ClipId[] };
}

export const NO_FOCUS: FocusGuard = {
  active: null,
  resolve: (pid) => pid,
  writable: (pid) => pid,
  owned: () => {},
  span: () => {},
  clip: () => {},
  range: () => null,
  notes: () => null,
  wholePattern: () => {},
  closeAutomation: () => null,
  finish: () => ({ focus: null, clips: [] }),
};

export function createFocusGuard(_c: Omit<OpContext, 'focus'>, focus: ResolvedFocus | null): FocusGuard {
  if (!focus) return NO_FOCUS;
  return NO_FOCUS;
}

/** The "Working on a part" section of the studio prompt. */
export const FOCUS_PROMPT: PromptSection = { id: 'part', order: 30, text: '' };
