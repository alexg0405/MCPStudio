/** What the beat writer plans and returns: where a beat lives, what options shape it, how its tracks map to channels. */
import type { ParamValue, PluginDef } from '@agstudio/sdk';
import type { BeatSound, BeatTrack } from '@core/beat/spec';
import type { Style } from '@core/beat/style';
import type { ChannelId, InstrumentChannel, PatternId, SampleRef } from '@core/model/types';

/** Where an applied beat lives, so follow-up requests can change it in place. */
export interface AppliedBeat {
  patternId: PatternId;
  /** Track name (lowercase) → channel. */
  channels: Record<string, ChannelId>;
  /** Channels the assistant created (it may set their sound); the rest were already in the project. */
  created: ChannelId[];
}

/** Options that shape how a beat is written. */
export interface ApplyOptions {
  /** Samples to play instead of the kit for these sounds ("use my sounds"); they get their own channels. */
  samples?: Partial<Record<BeatSound, SampleRef>>;
  /** Rewrite this pattern (a beat names one) rather than the previous beat's or a new one. */
  patternId?: PatternId;
  /** Channels the assistant made earlier (in this answer or conversation): it may set their sound too. */
  own?: Iterable<ChannelId>;
}

/** One track's channel, decided before the edit (new channels are built outside the recipe). */
export interface PlannedTrack {
  track: BeatTrack;
  channelId: ChannelId;
  make?: InstrumentChannel;
  sample?: SampleRef;
  /** A sampler channel of the assistant's that now plays this sample ("use my sounds"). */
  swap?: SampleRef;
  /** A kit channel still at its defaults switches to the style's kit sample. */
  kit?: SampleRef;
  /** The writer may set this channel's sound (its own channel, or a kit channel at its defaults). */
  own: boolean;
  /** A new instrument and preset for an own channel (the track names a preset). */
  sound?: { def: PluginDef; params: Record<string, ParamValue>; state: unknown };
}

/** Where each track of a beat goes. */
export interface BeatPlan {
  patternId: PatternId;
  reuse: AppliedBeat | null;
  channels: Record<string, ChannelId>;
  created: Set<ChannelId>;
  /** The style the beat is written in (its own, or guessed from its tempo, swing and kick). */
  style: Style;
  /** Channels whose level (volume or pan) the beat set: the mix setup leaves those alone. */
  levels: Set<ChannelId>;
  /** Presets that weren't found, and the like. */
  warnings: string[];
  tracks: PlannedTrack[];
}
