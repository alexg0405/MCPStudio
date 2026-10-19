/** The "Make harmonies" dialog's rows as plain data: how a row turns into a rule and a voice, what warnings it shows, the starting sets. */
import { defaultVoice, type HarmonySpec, type VoiceSpec } from '@app/harmony/voice-spec';
import { DEFAULT_HUMANIZE, NAMED_INTERVALS } from '@core/harmony/voices';
import type { GuideNote, HarmonyRule, Project } from '@core/model/types';
import { guideNotesOfChannel } from '@core/query/harmony-voices';

/** What the rule menu offers besides the named intervals. */
export const CHORD_ABOVE = 'chord_above';
export const CHORD_BELOW = 'chord_below';
export const FIXED = 'fixed';
export const GUIDE = 'guide';

/** The menu of rules: [value, label, hint]. */
export const RULE_CHOICES: readonly { value: string; label: string; hint: string }[] = [
  ...NAMED_INTERVALS.map((i) => ({
    value: i.id,
    label: i.label,
    hint: `Sings ${i.label.toLowerCase()} the lead, on notes of the song key`,
  })),
  { value: CHORD_ABOVE, label: 'Chord tone above', hint: 'Sings the nearest note of the chord under the lead that is higher; several chord voices keep their order and move smoothly' },
  { value: CHORD_BELOW, label: 'Chord tone below', hint: 'Sings the nearest note of the chord under the lead that is lower' },
  { value: FIXED, label: 'Fixed interval…', hint: 'Sings a set number of semitones above or below the lead, whatever the key' },
  { value: GUIDE, label: 'Guide melody…', hint: 'Sings the notes an instrument channel plays: you write the harmony, it sings it' },
];

/** One voice as the dialog edits it. */
export interface VoiceRow {
  choice: string;
  /** For a fixed interval, semitones (−12…12). */
  semitones: number;
  /** For a guide melody, the instrument channel whose notes are sung ('' = none chosen). */
  guideChannel: string;
  levelDb: number;
  pan: number;
  formantCents: number;
}

/** The row for a rule (a starting point: the dialog's own choices). */
export function rowFor(voice: VoiceSpec): VoiceRow {
  const rule = voice.rule;
  const named = rule.kind === 'interval' ? NAMED_INTERVALS.find((i) => i.steps === rule.steps) : undefined;
  const choice =
    named?.id ?? (rule.kind === 'chord' ? (rule.side === 'above' ? CHORD_ABOVE : CHORD_BELOW) : rule.kind === 'midi' ? GUIDE : FIXED);
  return {
    choice,
    semitones: rule.kind === 'semitones' ? rule.semitones : 4,
    guideChannel: '',
    levelDb: voice.levelDb,
    pan: voice.pan,
    formantCents: voice.formantCents,
  };
}

/** The rule a row stands for; `guide` is what a guide melody sings (read from the project). A guide row with none gives null. */
export function ruleOfRow(row: VoiceRow, guide: readonly GuideNote[]): HarmonyRule | null {
  const named = NAMED_INTERVALS.find((i) => i.id === row.choice);
  if (named) return { kind: 'interval', steps: named.steps };
  if (row.choice === CHORD_ABOVE) return { kind: 'chord', side: 'above' };
  if (row.choice === CHORD_BELOW) return { kind: 'chord', side: 'below' };
  if (row.choice === FIXED) return { kind: 'semitones', semitones: Math.max(-12, Math.min(12, row.semitones)) };
  return guide.length > 0 ? { kind: 'midi', notes: [...guide] } : null;
}

/** The guide notes a row sings (empty for other rows). */
export function guideOfRow(project: Project, row: VoiceRow): GuideNote[] {
  if (row.choice !== GUIDE || !row.guideChannel) return [];
  return guideNotesOfChannel(project, row.guideChannel as Parameters<typeof guideNotesOfChannel>[1]);
}

/** The request the rows make, or the plain reason they can't (a guide row with no notes). */
export function specOfRows(project: Project, rows: readonly VoiceRow[], humanize: HarmonySpec['humanize'], seed: number): HarmonySpec | { problem: string } {
  const voices: VoiceSpec[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as VoiceRow;
    const rule = ruleOfRow(row, guideOfRow(project, row));
    if (!rule) return { problem: `Voice ${i + 1}: choose an instrument channel that plays the guide melody (it needs notes in a pattern on the playlist).` };
    voices.push({ rule, levelDb: row.levelDb, pan: row.pan, formantCents: row.formantCents });
  }
  return { voices, humanize, seed };
}

/** What the dialog says under the voices: a missing key, an empty chord track. Empty when all is well. */
export function warningsFor(project: Project, rows: readonly VoiceRow[]): string[] {
  const warnings: string[] = [];
  const usesKey = rows.some((r) => NAMED_INTERVALS.some((i) => i.id === r.choice));
  const usesChords = rows.some((r) => r.choice === CHORD_ABOVE || r.choice === CHORD_BELOW);
  if (usesKey && !project.transport.key) warnings.push('The song has no key yet. Set it in Song settings (or choose a fixed interval or chord tones), then make the harmonies.');
  if (usesChords && Object.keys(project.chords ?? {}).length === 0) {
    warnings.push('The chord track is empty, so chord voices will sing a third from the key. Add chords (Playlist ▸ Chord track) to follow them.');
  }
  return warnings;
}

/** A starting set of voices. */
export interface StartingSet {
  name: string;
  hint: string;
  choices: readonly string[];
}

/** Sets that fill the voice list in one click. */
export const STARTING_SETS: readonly StartingSet[] = [
  { name: 'Thirds', hint: 'A third above and a third below: the classic two-part backing', choices: ['third_above', 'third_below'] },
  { name: 'Chord stack', hint: 'Two voices above and one below, each on a note of the chord that sounds', choices: [CHORD_ABOVE, CHORD_ABOVE, CHORD_BELOW] },
  { name: 'Choir', hint: 'Third and fifth above, third and an octave below: four voices', choices: ['third_above', 'fifth_above', 'third_below', 'octave_below'] },
];

/** The rows of a starting set, with the usual level and pan for a stack that size. */
export function rowsOfSet(set: StartingSet): VoiceRow[] {
  return set.choices.map((choice, i) => {
    const named = NAMED_INTERVALS.find((n) => n.id === choice);
    const rule: HarmonyRule = named
      ? { kind: 'interval', steps: named.steps }
      : { kind: 'chord', side: choice === CHORD_BELOW ? 'below' : 'above' };
    return rowFor(defaultVoice(rule, i, set.choices.length));
  });
}

/** What the dialog opens with: two voices and the default humanize. */
export function initialRows(): VoiceRow[] {
  return rowsOfSet(STARTING_SETS[0] as StartingSet);
}

export const initialHumanize = () => ({ ...DEFAULT_HUMANIZE });
