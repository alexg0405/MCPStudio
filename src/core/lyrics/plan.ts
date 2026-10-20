/**
 * Planning a paste of lyrics: text in, placed words out. This is the one place that decides where syllables go, so the
 * "Paste lyrics…" dialog, the Lyrics window and the AI's `set_lyrics` all place them the same way. Pure.
 */
import type { Tick } from '../model/types';
import { parseLyrics } from './parse';
import { spreadEvenly, spreadOnSlots, type PlacedWord } from './spread';
import type { Slot } from './slots';

/** How syllables are laid out: on the notes of a melody, on the notes a singer sang, or evenly over bars. */
export type LyricAlign = 'notes' | 'clip' | 'even';
export const LYRIC_ALIGNS: readonly LyricAlign[] = ['notes', 'clip', 'even'];

/** What to place. */
export interface LyricsRequest {
  text: string;
  align: LyricAlign;
  /** Where the lyrics start (ticks): notes before it are not used. */
  fromTick: Tick;
  /** Where they end (ticks); optional. For `even` all syllables are spread between the two; for the others notes after it are not used. */
  toTick?: Tick;
  barTicks: Tick;
  /** `even` without `toTick`: bars one line takes (default 1). */
  barsPerLine?: number;
  /** The slots to use for `notes` and `clip` (song ticks, any order); `even` ignores them. */
  slots?: readonly Slot[];
  /** The number the first new line gets (so new lines never share a number with old ones). */
  firstLine: number;
}

/** What `planLyrics` made. */
export interface LyricsPlan {
  words: PlacedWord[];
  /** Lines and syllables found in the text. */
  lineCount: number;
  syllableCount: number;
  /** Syllables with no note to go on (not placed). */
  leftover: number;
  /** Notes that got no syllable. */
  emptySlots: number;
  /** The text was cut at the most syllables one paste keeps. */
  isTruncated: boolean;
  /** Why nothing was placed, in plain words (absent when something was). */
  problem?: string;
}

const NOTHING: Omit<LyricsPlan, 'problem'> = { words: [], lineCount: 0, syllableCount: 0, leftover: 0, emptySlots: 0, isTruncated: false };

/** The slots a request may use: in time order, from `fromTick` (and before `toTick` when given). */
function usableSlots(request: LyricsRequest): Slot[] {
  return [...(request.slots ?? [])]
    .filter((slot) => slot.tick >= request.fromTick && (request.toTick === undefined || slot.tick < request.toTick))
    .sort((a, b) => a.tick - b.tick);
}

/** A plan with nothing placed, and the reason. */
const refused = (problem: string, base: Partial<LyricsPlan> = {}): LyricsPlan => ({ ...NOTHING, ...base, problem });

/** Lays the text out: parses it, then spreads the syllables as the request says. */
export function planLyrics(request: LyricsRequest): LyricsPlan {
  const parsed = parseLyrics(request.text);
  const found = { lineCount: parsed.lines.length, syllableCount: parsed.count, isTruncated: parsed.isTruncated };
  if (parsed.count === 0) return refused('there are no words in the text', found);
  if (request.align === 'even') {
    const words = spreadEvenly(parsed.lines, {
      fromTick: request.fromTick,
      barTicks: request.barTicks,
      firstLine: request.firstLine,
      ...(request.toTick !== undefined ? { toTick: request.toTick } : {}),
      ...(request.barsPerLine !== undefined ? { barsPerLine: request.barsPerLine } : {}),
    });
    return { ...NOTHING, ...found, words };
  }
  const slots = usableSlots(request);
  if (slots.length === 0) {
    const where = request.align === 'clip' ? 'the sung notes of that clip' : 'the notes';
    return refused(`there are no notes to put the words on (${where} from there); try even spacing`, found);
  }
  const spread = spreadOnSlots(parsed.lines, slots, request.firstLine);
  return { ...NOTHING, ...found, words: spread.words, leftover: spread.leftover, emptySlots: spread.emptySlots };
}

/** What a plan did, in a sentence for a toast or the AI's answer ("Placed 14 syllables on 14 notes; 3 words had no note"). */
export function describePlan(plan: LyricsPlan, align: LyricAlign): string {
  if (plan.problem) return `No lyrics placed: ${plan.problem}.`;
  const lines = `${plan.lineCount} line${plan.lineCount === 1 ? '' : 's'}`;
  const target = align === 'even' ? 'spaced evenly' : align === 'clip' ? 'on the sung notes' : 'on the notes';
  const notes: string[] = [];
  if (plan.leftover) notes.push(`${plan.leftover} syllable${plan.leftover === 1 ? '' : 's'} had no note and ${plan.leftover === 1 ? 'was' : 'were'} left out`);
  if (plan.emptySlots) notes.push(`${plan.emptySlots} note${plan.emptySlots === 1 ? '' : 's'} got no word`);
  if (plan.isTruncated) notes.push('the text was cut at 4096 syllables');
  return `Placed ${plan.words.length} syllable${plan.words.length === 1 ? '' : 's'} (${lines}) ${target}${notes.length ? `; ${notes.join('; ')}` : ''}.`;
}
