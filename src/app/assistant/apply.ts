/**
 * The beat writer: turns a beat (`core/beat/spec`) into a pattern and its channels, inside one
 * undoable edit. Channels are shared like FL patterns share them: a track reuses the channel of the
 * same name, the project's kit channel for its drum or its 808. New channels get the style's sound
 * (the palette) and drum kit; the writer changes the sound only of channels it made itself or kit
 * channels still at their defaults, while levels the beat sets apply to any channel.
 *
 * The work is split into `beat-writer/`: `plan` decides which channels the tracks use (matching in
 * `channel-matching`, instruments in `sounds`), `write` puts the plan into a draft.
 */
import type { BeatSound, BeatSpec } from '@core/beat/spec';
import type { Services } from '../services';
import { BASS808_ID, SYNTH as SYNTH_SETTINGS } from './palette';
import { planBeat } from './beat-writer/plan';
import type { AppliedBeat, ApplyOptions, BeatPlan } from './beat-writer/types';
import { writeBeat } from './beat-writer/write';

export { BASS808_ID, planBeat, writeBeat };
export type { AppliedBeat, ApplyOptions, BeatPlan };
export type { PlannedTrack } from './beat-writer/types';

/** 3xOsc settings for the synth sounds (the MIDI import uses them too). */
export const SYNTH: Partial<Record<BeatSound, Record<string, number | string>>> = SYNTH_SETTINGS;

/** Writes a beat into the project as one undo step (see `planBeat`) and selects it. */
export function applyBeatSpec(
  services: Services,
  spec: BeatSpec,
  previous?: AppliedBeat | null,
  options: ApplyOptions = {},
): AppliedBeat {
  const plan = planBeat(services, services.doc.getState().project, spec, previous, options);
  services.history.transact(`Assistant: ${spec.title}`, (draft) => writeBeat(services, draft, spec, plan));
  return showBeat(services, plan);
}

/** Selects the beat's pattern and first channel; returns where the beat lives (for follow-ups). */
export function showBeat(services: Services, plan: BeatPlan): AppliedBeat {
  services.view.getState().setCurrentPattern(plan.patternId);
  // The first track's (not the first key's: "808" would sort before "kick").
  const firstChannel = plan.tracks[0]?.channelId ?? Object.values(plan.channels)[0];
  if (firstChannel) services.session.getState().selectChannel(firstChannel);
  return { patternId: plan.patternId, channels: plan.channels, created: [...plan.created] };
}
