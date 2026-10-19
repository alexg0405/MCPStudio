/**
 * Tells whether a harmony voice is out of date: a short string over everything its render was made from (the lead's sound and
 * the part of it the clip plays, the song key and the chords the rule reads, the settings). A voice whose record holds a
 * different signature than the one worked out now needs "Update harmonies".
 */
import { hashString } from '../../arrange/random';
import type { ChordEvent, HarmonyHumanize, HarmonyRule } from '../../model/types';

/** What a harmony render is made from. */
export interface SignatureInput {
  /** The lead's played sound: the sample (or its pitch-correction render) by content, and how the channel plays it. */
  sound: string;
  /** The part of the sample the lead clip plays, seconds from and to (rounded to the millisecond). */
  from: number;
  to: number;
  /** Where the lead clip sits (ticks): it decides which chord sounds under each note. */
  start: number;
  rule: HarmonyRule;
  formantCents: number;
  humanize: HarmonyHumanize;
  seed: number;
  /** The song key ("9:minor"), or '' for none. Read by diatonic and chord rules. */
  key: string;
  /** The chords under the lead clip (read by chord rules). */
  chords: readonly Pick<ChordEvent, 'tick' | 'length' | 'root' | 'quality' | 'bass'>[];
  /** The song tempo, BPM: it places the notes among the chords. */
  bpm: number;
}

const ms = (seconds: number) => Math.round(seconds * 1000);

/** The signature of a render's inputs: equal inputs give equal strings, a change anywhere that matters gives another. */
export function harmonySignature(input: SignatureInput): string {
  const readsKey = input.rule.kind === 'interval' || input.rule.kind === 'chord';
  const readsChords = input.rule.kind === 'chord';
  const parts = [
    input.sound,
    ms(input.from),
    ms(input.to),
    JSON.stringify(input.rule),
    Math.round(input.formantCents),
    input.humanize.timingMs,
    input.humanize.driftCents,
    input.humanize.vibrato,
    input.seed,
    readsKey ? input.key : '',
    readsChords ? input.start : '',
    readsChords ? Math.round(input.bpm * 1000) : '',
    readsChords ? input.chords.map((c) => `${c.tick},${c.length},${c.root},${c.quality},${c.bass ?? ''}`).join(';') : '',
  ];
  return hashString(parts.join('|')).toString(16).padStart(8, '0');
}
