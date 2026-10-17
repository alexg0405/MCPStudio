/** What applying an AI answer takes and returns. */
import type { Style } from '@core/beat/style';
import type { FilterTarget } from '@core/filters/target';
import type { DjMixOptions } from '@core/model/types';
import type { MixSong } from '../../dj/mix';
import type { DeckAction } from './decks';
import type { ChannelId, ClipId, InsertId, SampleRef, SlotId, Tick } from '@core/model/types';
import type { AppliedBeat } from '../../assistant/apply';
import type { PluginSpec } from '../builder';
import type { AiFocus, ResolvedFocus } from '../focus';
import type { OpenWindow } from './windows';

/** What the UI should do after the edit. */
export type AfterEdit =
  | {
      kind: 'open';
      window: Exclude<OpenWindow, 'browser'>;
      channelId?: ChannelId;
      insertId?: InsertId;
      slotId?: SlotId;
    }
  | { kind: 'play'; fromTick?: number; mode?: 'pattern' | 'song'; record?: boolean }
  | { kind: 'stop' }
  | { kind: 'metronome'; on: boolean }
  | { kind: 'mode'; mode: 'pattern' | 'song' }
  /** An app command; `gesture` ones (file dialogs) wait for the musician's click. */
  | { kind: 'command'; id: string; args?: unknown; gesture: boolean }
  /** A new plugin for the plugin builder to write. */
  | { kind: 'build_plugin'; spec: PluginSpec }
  /** Listen to the mix first: the analysis comes back to the AI with the request. */
  | { kind: 'analyze_mix' }
  /** Play a short phrase on a channel (preview notes, nothing written). */
  | { kind: 'audition'; channelId: ChannelId; phrase: AuditionPhrase }
  /** Render the busiest part and set the faders and master to the style's levels (its own step, after the edit). */
  | { kind: 'level_mix'; style: Style; fromTick?: Tick; bars?: number; targetLufs?: number }
  /** Analyze songs that need it, then make the DJ mix (its own step, after the edit). */
  | { kind: 'dj_mix'; songs: MixSong[]; options: DjMixOptions }
  /** Live DJ deck actions (load, play, sync, crossfade…): they run after the answer; the decks are not part of the project. */
  | { kind: 'decks'; actions: DeckAction[] }
  /** Render a part and play it through a sound filter (its own step, after the edit). */
  | { kind: 'filter'; filter: string; target: FilterTarget }
  /** Analyze a reference song, then set it (its own step, after the edit). */
  | { kind: 'set_reference'; ref: SampleRef; title: string }
  /** Match the reference once it is set (the answer set it too, and it was still being analyzed). */
  | { kind: 'match_reference'; options: ReferenceMatchOptions }
  /** Listen to the mix and compare its tonal balance with the reference's (its own step, after the edit). */
  | { kind: 'reference_tone' };

/** What `match_reference` was asked to match. */
export interface ReferenceMatchOptions {
  tempo: boolean;
  key: boolean;
  arrangement: boolean;
  loudness: boolean;
  tone: boolean;
}

export type AuditionPhrase = 'chord' | 'riff' | 'bass' | 'hits';

export interface ApplyContext {
  /** The beat the conversation is working on (a beat action changes it in place). */
  previousBeat: AppliedBeat | null;
  /** Undo label (the request); defaults to the start of the message. */
  label?: string;
  /** The part of the song the request is about: edits stay inside it. */
  focus?: ResolvedFocus | null;
  /**
   * Edits beyond the part: refused (the default), or allowed because the musician approved them.
   * Either way they're listed in `outsideFocus`.
   */
  focusOutside?: 'refuse' | 'allow';
  /** Work out what the answer would do without changing the project (nothing is committed). */
  dryRun?: boolean;
}

export interface AppliedTurn {
  /** One line per change, for the chat. */
  changes: string[];
  /** Actions that couldn't be applied, and why. */
  warnings: string[];
  /** Set when a beat was written (follow-ups change the same pattern). */
  beat: AppliedBeat | null;
  after: AfterEdit[];
  /** Whether the project changed (an undo step was made). */
  edited: boolean;
  /** What the app itself did that is not an edit (settings, selection, windows), one line each: no undo step. */
  ui?: string[];
  /** The answers of `query` actions: what the read tools returned, for the next turn. */
  queries?: { tool: string; args: Record<string, unknown>; result: unknown }[];
  /** Song-check notes about what this answer did (doubled parts…). */
  findings?: string[];
  /** The playlist span the answer edited (autoplay starts there). */
  touched?: { from: Tick; to: Tick } | null;
  /** Clips to select after the edit. */
  selectClips?: ClipId[];
  /** The focus after the edit (copies made for it, clips that moved). */
  focus?: AiFocus | null;
  /** What reached outside the part being worked on, one line each. */
  outsideFocus?: string[];
}
