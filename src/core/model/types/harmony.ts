import type { ClipId, Tick } from './ids';

/**
 * Harmony voices made from a sung lead ("Make harmonies…", see core/harmony/voices). A harmony clip is an ordinary audio
 * clip on its own track whose sound is a render of the lead's notes shifted to a target; this file holds the record of how
 * it was made, which `AudioClip.harmony` keeps so the voice can be made again when the lead or the chords change.
 */

/** One note of a guide melody ("sing these notes"): a MIDI note over a stretch of the song. */
export interface GuideNote {
  tick: Tick;
  length: Tick;
  /** MIDI note number (60 = middle C). */
  pitch: number;
}

/** Which note a harmony voice sings against each note of the lead. */
export type HarmonyRule =
  /** A diatonic interval in the song key, in scale steps: +2 = a third above, -2 = a third below, +4 a fifth, +5 a sixth, +7 an octave. */
  | { kind: 'interval'; steps: number }
  /** A fixed interval in semitones (+7 = a perfect fifth above; the lead's own tuning is kept). */
  | { kind: 'semitones'; semitones: number }
  /** The nearest tone of the chord track's chord above or below the lead; several of these keep their order and move smoothly. */
  | { kind: 'chord'; side: 'above' | 'below' }
  /** The notes of a guide melody: the voice sings whichever note sounds at the start of each lead note (silent where none does). */
  | { kind: 'midi'; notes: GuideNote[] };

/** The small differences that keep a stack of voices from phasing into one voice. */
export interface HarmonyHumanize {
  /** Each note starts up to this many milliseconds early or late (0–40). */
  timingMs: number;
  /** Each note's pitch is off by up to this many cents (0–40). */
  driftCents: number;
  /** How much the vibrato differs from the lead's, 0–1 (0.3 = each note's vibrato is 70–130 % of the lead's). */
  vibrato: number;
}

/** What a harmony clip remembers about how it was made. */
export interface HarmonyVoiceRecord {
  /** The harmonies made together (one "Make harmonies" run) share this. */
  group: string;
  /** Which voice of the group it is (0-based, in the order they were asked for). */
  voice: number;
  /** The lead clip the voice was made from. */
  source: ClipId;
  rule: HarmonyRule;
  /** Moves the voice's formants, in cents (−300…300): a bit up or down sounds like a different singer. */
  formantCents: number;
  humanize: HarmonyHumanize;
  /** Seeds the humanize numbers, so making the voice again gives the same take. */
  seed: number;
  /** What the render was made from (`harmonySignature`); it is out of date when the lead, the chords or the key differ. */
  renderedFor?: string;
}
