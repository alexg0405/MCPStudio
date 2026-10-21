/**
 * The shapes the offline edit interpreter passes around: what it is asked (words, the project, the part of the song asked
 * about), what it answers (the same kind of actions an AI's answer carries, or a plain reply) and the small pieces rules share.
 */
import type { Role } from '../arrange/roles';
import type { ChannelId, Project } from '../model/types';
import type { SongFacts } from './song-facts';

/** One action as the AI studio reads it: an `op` name and its fields (the schemas live in `app/ai/ops`). */
export type OfflineAction = { op: string } & Record<string, unknown>;

/** A span of whole bars, 1-based and inclusive on both ends, as the AI's actions say bars. */
export interface BarRange {
  fromBar: number;
  toBar: number;
}

/** What the interpreter is asked. */
export interface EditInput {
  /** The musician's words. */
  text: string;
  /** The project as it is now (never changed here). */
  project: Project;
  /** What each channel plays (kick, hat, lead…), with the app's plugin hints applied. */
  roles: ReadonlyMap<ChannelId, Role>;
  /** The part of the song the request is about (its bars and its name), when the musician picked one. */
  focus: { range: BarRange; label: string } | null;
  /** How many edits this conversation made so far: asking for "a new melody" again gives another one. */
  variation: number;
}

/** What the interpreter answers. */
export type EditOutcome =
  /** Actions to apply as one answer. `guard`: the one span the edits must stay inside, when there is exactly one. */
  | { kind: 'edit'; message: string; actions: OfflineAction[]; guard: BarRange | null }
  /** A reply with no change: the request was understood but cannot be done here, or help was asked for. */
  | { kind: 'reply'; text: string }
  /** The words are not an edit of the song at all (a new beat or song is wanted instead). */
  | { kind: 'none' };

/** How much of a change a request asks for ("a bit", nothing said, "a lot"). */
export type Amount = 'small' | 'medium' | 'large';

/** The part of the song a request is about. */
export interface Scope {
  /** The spans, in song order (the whole song when nothing was named). Never empty for a song with clips. */
  ranges: BarRange[];
  /** True when the musician named a part (a section, bars) or picked one. */
  isNamed: boolean;
  /** True when the part came from the musician's focus, not from the words. */
  isFocus: boolean;
  /** "the Hook (bars 17–24)", "bars 9–16", "the whole song". */
  label: string;
  /** Where in the part the request points ("into", "before", "at the end"), when it says. */
  anchor: 'into' | 'before' | 'after' | 'end' | 'start' | null;
}

/** One song section as the interpreter reads it. */
export interface SectionInfo {
  name: string;
  /** The part of the song its name says ("verse", "hook"…), if it says. */
  role: string | undefined;
  range: BarRange;
}

/** What a rule answers: actions with a headline, or a plain reply. */
export type RuleResult = { message: string; actions: OfflineAction[] } | { reply: string };

/** Everything a rule is given. */
export interface RuleContext {
  input: EditInput;
  /** The song as read for this request. */
  facts: SongFacts;
  /** The clause, lower case, with the part named in it taken out. */
  text: string;
  /** The whole clause, lower case, part and all (some words are both a part of the song and a thing to make: "the hook"). */
  clause: string;
  /** The one span the answer is held to, when there is exactly one (the app's focus guard then copies patterns shared with the rest). */
  guard: BarRange | null;
  scope: Scope;
  amount: Amount;
  /** A number that differs with the words and the number of edits so far: the seed of anything that is made new. */
  seed: number;
}

/** A way of understanding words: when it fits, and what it does. */
export interface Rule {
  id: string;
  /** Whether these words ask for this: `text` is the clause without the part named in it, `clause` has it. */
  matches(text: string, clause: string): boolean;
  run(context: RuleContext): RuleResult;
  /** False for a rule that works on an empty playlist too (tempo, swing). Default true. */
  needsSong?: boolean;
}
