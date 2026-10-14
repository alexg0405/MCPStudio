/** What applying an AI answer takes and returns. */
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
  | { kind: 'audition'; channelId: ChannelId; phrase: AuditionPhrase };

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
