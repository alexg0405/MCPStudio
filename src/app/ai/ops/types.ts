/** What applying an AI answer takes and returns. */
import type { Style } from '@core/beat/style';
import type { FilterTarget } from '@core/filters/target';
import type { DjMixOptions } from '@core/model/types';
import type { MixSong } from '../../dj/mix';
import type { ChannelId, ClipId, InsertId, SlotId, Tick } from '@core/model/types';
import type { AppliedBeat } from '../../assistant/apply';
import type { PluginSpec } from '../builder';
import type { AiFocus, ResolvedFocus } from '../focus';

/** What the UI should do after the edit. */
export type AfterEdit =
  | {
      kind: 'open';
      window: 'mixer' | 'channel-rack' | 'piano-roll' | 'playlist' | 'plugin';
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
  | { kind: 'level_mix'; style: Style; fromTick?: Tick; bars?: number }
  /** Analyze songs that need it, then make the DJ mix (its own step, after the edit). */
  | { kind: 'dj_mix'; songs: MixSong[]; options: DjMixOptions }
  /** Render a part and play it through a sound filter (its own step, after the edit). */
  | { kind: 'filter'; filter: string; target: FilterTarget };

export type AuditionPhrase = 'chord' | 'riff' | 'bass' | 'hits';

export interface ApplyContext {
  /** The beat the conversation is working on (a beat action changes it in place). */
  previousBeat: AppliedBeat | null;
  /** Undo label (the request); defaults to the start of the message. */
  label?: string;
  /** The part of the song the request is about: edits stay inside it. */
  focus?: ResolvedFocus | null;
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
  /** Song-check notes about what this answer did (doubled parts…). */
  findings?: string[];
  /** The playlist span the answer edited (autoplay starts there). */
  touched?: { from: Tick; to: Tick } | null;
  /** Clips to select after the edit. */
  selectClips?: ClipId[];
  /** The focus after the edit (copies made for it, clips that moved). */
  focus?: AiFocus | null;
}
