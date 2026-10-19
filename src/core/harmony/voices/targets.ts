/**
 * What each harmony voice sings: for every note of the lead, the pitch (MIDI, fractional) a voice should land on, by its rule.
 * Pure (no DOM, no project): the chord track and the song key arrive as small functions, so the app, the AI and the tests all
 * plan the same way.
 *
 * Rules: a diatonic interval counts scale steps in the song key (a third above is two steps up, wherever the lead sits);
 * a fixed interval adds semitones and keeps the lead's own tuning; a chord rule picks tones of the chord that sounds under
 * the note, with the voices of one side kept in order (never crossing) and moving as little as they can from note to note;
 * a guide melody sings whatever note of it sounds at the start of the lead's note.
 */
import { chordPitchClasses, mod12 } from '../chord';
import { harmonicScale, type KeyLike } from '../scale';
import type { GuideNote, HarmonyRule } from '../../model/types';

/** A note of the lead as planning sees it: the pitch that sounds, and where it sits in the song. */
export interface LeadNote {
  /** MIDI note number as heard in the song (fractional: cents). */
  pitch: number;
  startTick: number;
  endTick: number;
}

/** Everything a plan reads from the song. */
export interface PlanContext {
  /** The song key, or null when none is set (diatonic intervals need one). */
  key: KeyLike | null;
  /** The pitch classes of the chord that sounds at a tick (bass included), or null where the chord track has none. */
  chordTonesAt: (tick: number) => readonly number[] | null;
}

/** Said in plain words to the musician: a rule that cannot be planned (no key, a missing guide melody). */
export class HarmonyPlanError extends Error {}

/** A voice may be at most this far (semitones) from the lead: TD-PSOLA keeps its quality within an octave. */
export const MAX_VOICE_INTERVAL = 12;
/** A chord tone counts as "above" the lead when it is at least this many semitones higher (so a note sung a little flat of a chord tone is not "above" itself). */
const MIN_CHORD_GAP = 0.5;
/** How far from the lead chord voices look for tones, semitones. */
const CHORD_REACH = MAX_VOICE_INTERVAL;
/** Weight of "stay close to the lead" against "move as little as possible" when a chord voice picks its tone. */
const CLOSENESS_WEIGHT = 0.15;
/** Where a chord voice's first note sits above the lead per voice number, semitones: about a third, then a fifth and so on. */
const FIRST_NOTE_OFFSET = 3.5;
/** Without a chord at a note, a chord voice sings this far from the lead, semitones. */
const NO_CHORD_ABOVE = 4;
const NO_CHORD_BELOW = 3;

/** Moves a target by octaves until it is within the largest voice interval of the lead. */
export function fitToLead(target: number, lead: number): number {
  let t = target;
  while (t - lead > MAX_VOICE_INTERVAL + 1e-9) t -= 12;
  while (lead - t > MAX_VOICE_INTERVAL + 1e-9) t += 12;
  return t;
}

/** The notes of the key's seven-note scale as MIDI numbers from 0 to 127, ascending. */
export function scaleNotes(key: KeyLike): number[] {
  const degrees = harmonicScale(key.scale);
  const notes: number[] = [];
  for (let midi = 0; midi <= 127; midi++) {
    if (degrees.includes(mod12(midi - key.root))) notes.push(midi);
  }
  return notes;
}

/** Index in `notes` of the note nearest to `pitch` (the lower one on a tie). */
function nearestIndex(notes: readonly number[], pitch: number): number {
  let best = 0;
  for (let i = 1; i < notes.length; i++) {
    if (Math.abs((notes[i] as number) - pitch) < Math.abs((notes[best] as number) - pitch) - 1e-9) best = i;
  }
  return best;
}

/** The scale note `steps` scale steps from the lead's nearest scale note. */
export function diatonicTarget(notes: readonly number[], lead: number, steps: number): number {
  const at = Math.max(0, Math.min(notes.length - 1, nearestIndex(notes, lead) + steps));
  return fitToLead(notes[at] as number, lead);
}

/** The guide note that sounds at `tick`, if any (the highest when several do). */
function guideNoteAt(guide: readonly GuideNote[], tick: number): GuideNote | null {
  let found: GuideNote | null = null;
  for (const g of guide) {
    if (tick >= g.tick && tick < g.tick + g.length && (!found || g.pitch > found.pitch)) found = g;
  }
  return found;
}

/** Every pitch of the given pitch classes within [low, high], ascending. */
function tonesBetween(pitchClasses: readonly number[], low: number, high: number): number[] {
  const tones: number[] = [];
  for (let midi = Math.ceil(low); midi <= Math.floor(high); midi++) {
    if (pitchClasses.includes(mod12(midi))) tones.push(midi);
  }
  return tones;
}

/** A voice that follows the chord track, and what it sang last. */
interface ChordVoice {
  /** Which voice (index in the rules). */
  voice: number;
  /** The side of the lead the voice sings on. */
  side: 'above' | 'below';
  /** 1 = the voice nearest the lead on its side, 2 = the next one out, and so on. */
  rank: number;
  /** What the voice sang on the last note (null at the start). */
  previous: number | null;
}

/** The chord voices among the rules; the first on a side is rank 1, the next rank 2. */
function chordVoicesOf(rules: readonly HarmonyRule[]): ChordVoice[] {
  const voices: ChordVoice[] = [];
  const perSide = { above: 0, below: 0 };
  rules.forEach((rule, voice) => {
    if (rule.kind !== 'chord') return;
    perSide[rule.side] += 1;
    voices.push({ voice, side: rule.side, rank: perSide[rule.side], previous: null });
  });
  return voices;
}

/**
 * The targets of the chord voices for one lead note, by voice number. Voices of a side are placed from the lead outwards, each
 * on a chord tone beyond the one before it (so they never cross or share a note), choosing the tone nearest to what that voice
 * sang last (with a little preference for staying near the lead). Without a chord, `noChord` says what a voice sings.
 */
function chordTargetsAt(
  lead: number,
  tones: readonly number[] | null,
  voices: readonly ChordVoice[],
  noChord: (v: ChordVoice) => number,
): Map<number, number> {
  const targets = new Map<number, number>();
  if (!tones || tones.length === 0) {
    for (const v of voices) targets.set(v.voice, noChord(v));
    return targets;
  }
  for (const side of ['above', 'below'] as const) {
    const sign = side === 'above' ? 1 : -1;
    const own = voices.filter((c) => c.side === side);
    let edge = lead + sign * MIN_CHORD_GAP;
    let last: number | null = null;
    own.forEach((v, index) => {
      const pick = pickTone(lead, tones, v, edge, sign, own.length - 1 - index);
      // Out of tones in reach: the voice doubles the one before it (an octave apart voices would cross).
      const chosen = pick ?? last ?? lead + sign * NO_CHORD_ABOVE;
      targets.set(v.voice, chosen);
      last = chosen;
      if (pick !== null) edge = chosen + sign * MIN_CHORD_GAP;
    });
  }
  return targets;
}

/**
 * The chord tone beyond `edge` (away from the lead) that a voice moves to most smoothly, leaving `voicesAfter` tones beyond it
 * for the voices still to be placed; null when none is in reach.
 */
function pickTone(lead: number, tones: readonly number[], v: ChordVoice, edge: number, sign: 1 | -1, voicesAfter: number): number | null {
  const far = lead + sign * CHORD_REACH;
  const beyond = tonesBetween(tones, Math.min(edge, far), Math.max(edge, far)).filter((tone) => (sign === 1 ? tone > edge - 1e-9 : tone < edge + 1e-9));
  // Nearest to the lead first, so "leaving room" means leaving the last few.
  const ordered = sign === 1 ? beyond : beyond.reverse();
  const allowed = ordered.slice(0, Math.max(0, ordered.length - voicesAfter));
  const candidates = allowed.length > 0 ? allowed : ordered.slice(0, 1);
  const ideal = v.previous ?? lead + sign * (FIRST_NOTE_OFFSET + 3 * (v.rank - 1));
  let pick: number | null = null;
  let bestCost = Infinity;
  for (const tone of candidates) {
    const cost = Math.abs(tone - ideal) + CLOSENESS_WEIGHT * Math.abs(tone - lead);
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      pick = tone;
    }
  }
  return pick;
}

/**
 * The pitch each voice sings on each lead note, `result[voice][note]`; null where a voice is silent (a guide melody with no
 * note there). Throws `HarmonyPlanError` in plain words when a rule cannot be planned (a diatonic interval without a key).
 */
export function planTargets(lead: readonly LeadNote[], rules: readonly HarmonyRule[], ctx: PlanContext): (number | null)[][] {
  const notes = ctx.key ? scaleNotes(ctx.key) : null;
  if (!notes && rules.some((r) => r.kind === 'interval')) {
    throw new HarmonyPlanError('Set the song key first (Song settings), or choose a fixed interval or the chord track.');
  }
  if (rules.some((r) => r.kind === 'midi' && r.notes.length === 0)) {
    throw new HarmonyPlanError('The guide melody has no notes: pick a pattern with notes, or choose another rule.');
  }
  const result: (number | null)[][] = rules.map(() => []);
  const chordVoices = chordVoicesOf(rules);
  for (const note of lead) {
    const noChord = (v: ChordVoice) => (notes ? diatonicTarget(notes, note.pitch, v.side === 'above' ? 2 : -2) : note.pitch + (v.side === 'above' ? NO_CHORD_ABOVE : -NO_CHORD_BELOW));
    const chord = chordTargetsAt(note.pitch, ctx.chordTonesAt(note.startTick), chordVoices, noChord);
    rules.forEach((rule, voice) => {
      (result[voice] as (number | null)[]).push(targetFor(rule, voice, note, notes, chord));
    });
    for (const v of chordVoices) v.previous = chord.get(v.voice) ?? v.previous;
  }
  return result;
}

/** The target of one voice on one lead note. */
function targetFor(rule: HarmonyRule, voice: number, note: LeadNote, notes: readonly number[] | null, chord: ReadonlyMap<number, number>): number | null {
  switch (rule.kind) {
    case 'interval':
      return diatonicTarget(notes as readonly number[], note.pitch, Math.round(rule.steps));
    case 'semitones':
      return fitToLead(note.pitch + rule.semitones, note.pitch);
    case 'chord':
      // Not folded by octaves: that could make voices cross. A voice out of reach is held to the largest interval when rendered.
      return chord.get(voice) ?? note.pitch;
    case 'midi': {
      const guide = guideNoteAt(rule.notes, note.startTick);
      return guide ? fitToLead(guide.pitch + 12 * Math.round((note.pitch - guide.pitch) / 12), note.pitch) : null;
    }
  }
}

/** The pitch classes of a chord event's notes, bass included: what `PlanContext.chordTonesAt` returns for it. */
export function chordTonePitchClasses(chord: { root: number; quality: string; bass?: number }): number[] {
  const tones = chordPitchClasses({ root: chord.root, quality: chord.quality });
  if (chord.bass !== undefined && !tones.includes(mod12(chord.bass))) tones.push(mod12(chord.bass));
  return tones;
}

/** The semitones each note moves to reach its target (null where the voice is silent). */
export function shiftsFromTargets(lead: readonly LeadNote[], targets: readonly (number | null)[]): (number | null)[] {
  return targets.map((target, i) => (target === null ? null : target - (lead[i] as LeadNote).pitch));
}
