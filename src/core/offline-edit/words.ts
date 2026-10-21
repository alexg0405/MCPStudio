/**
 * Reading plain words for the offline editor: spelling out numbers, "a bit" and "a lot", "+3 dB", tempo and key changes, and
 * cutting a request into the separate things it asks for. Everything here works on lower-case text and never looks at a project.
 */
import type { Amount } from './types';

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  sixteen: 16,
  twenty: 20,
  'thirty two': 32,
  'thirty-two': 32,
};

/** The number words that read as digits ("two bars" is "2 bars"); a lone "a" and "one" stay words so "a bit" survives. */
const NUMBER_WORD_PATTERN = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b(?=\\s*(?:-\\s*)?(?:bars?|semitones?|steps?|half steps?|db|decibels?|bpm|percent|%|st\\b))`, 'g');

/**
 * The words made easy to match: lower case, plain quotes and dashes, "&" as "and", digits for spelled-out counts, no
 * trailing punctuation, single spaces.
 */
export function normalizeWords(text: string): string {
  const plain = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/&/g, ' and ')
    .replace(NUMBER_WORD_PATTERN, (word) => String(NUMBER_WORDS[word] ?? word))
    .replace(/\s+/g, ' ')
    .trim();
  return plain.replace(/[.!?\s]+$/, '');
}

const SMALL_AMOUNT = /\b(a (?:little|bit|touch|tad|smidge|notch)|slightly|barely|subtl[ey]|tiny|just a (?:bit|little)|little bit|somewhat|gently)\b/;
const LARGE_AMOUNT =
  /\b(much|a lot|way|far|really|so much|loads|heavily|massively|tons|super|very|hugely|considerably|extremely|dramatically|completely|totally|maximum|a ton)\b/;

/** How much of a change the words ask for: "a bit" is small, "much" or "a lot" large, nothing said is medium. */
export function amountOf(text: string): Amount {
  if (LARGE_AMOUNT.test(text)) return 'large';
  if (SMALL_AMOUNT.test(text)) return 'small';
  return 'medium';
}

/** Picks the value for an amount: `[small, medium, large]`. */
export function byAmount<T>(amount: Amount, values: readonly [T, T, T]): T {
  if (amount === 'small') return values[0];
  if (amount === 'large') return values[2];
  return values[1];
}

/** A level change in dB: "+3 dB", "3 db louder", "turn it down 2 decibels", "-4db"; null when no number of dB is named. */
export function decibelsIn(text: string): number | null {
  const found = /([+-])?\s*(\d+(?:\.\d+)?)\s*(?:db|decibels?)\b/.exec(text);
  if (!found) return null;
  const size = Number(found[2]);
  if (found[1] === '-') return -size;
  if (found[1] === '+') return size;
  // Without a sign the words decide.
  return /\b(quieter|lower|down|softer|less|cut|reduce|drop|decrease|minus|pull)\b/.test(text) ? -size : size;
}

/** The separate things a request asks for ("busier hats, then a new melody for the chorus" is two). */
export function splitClauses(text: string): string[] {
  /** Words an "and" must be followed by to start a new request rather than join two nouns ("kick and snare"). */
  const NEW_REQUEST =
    /^(?:please |also |then )?(?:make|add|put|turn|give|set|change|use|remove|clean|transpose|raise|lower|bring|write|create|let|try|more|less|busier|simpler|louder|quieter|fewer|(?:an? |some )?(?:new|different|fresh|another|bigger|longer|shorter)|no |smoother|bigger|wider|shift|move|mute|drop|swap|switch|speed|slow|cut|boost|tempo|key|bpm|swing)\b/;
  const pieces: string[] = [];
  for (const part of text.split(/\s*(?:[,;]|\.\s|\bthen\b|\bplus\b|\balso\b|\bafterwards\b)\s*/)) {
    if (part.trim()) pieces.push(part.trim());
  }
  const clauses: string[] = [];
  for (const piece of pieces) {
    const sides = piece.split(/\s+and\s+/);
    let current = sides[0] ?? '';
    for (const side of sides.slice(1)) {
      if (NEW_REQUEST.test(side)) {
        clauses.push(current);
        current = side;
      } else {
        current = `${current} and ${side}`;
      }
    }
    clauses.push(current);
  }
  return clauses.map((clause) => clause.replace(/^(?:and|please|can you|could you|i want you to|i'd like you to|i want|let's|lets)\s+/g, '').trim()).filter(Boolean);
}

/** A tempo the words ask for, with what to say about it. */
export interface TempoChange {
  bpm: number;
  summary: string;
}

/** The tempo limits the song settings accept (BPM). */
export const MIN_BPM = 40;
export const MAX_BPM = 300;

const clampBpm = (bpm: number): number => Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));

/**
 * A tempo change in the words: a number ("tempo 120", "set it to 128 bpm", "at 90 bpm"), a feel ("double time", "half time"),
 * or a direction ("faster", "a bit slower", "speed it up by 10 bpm"). Null when the words do not ask for a tempo change.
 */
export function tempoChangeIn(text: string, currentBpm: number, amount: Amount): TempoChange | null {
  const named = /(\d{2,3}(?:\.\d+)?)\s*(?:bpm|beats per minute)|\b(?:tempo|speed)\s*(?:to|of|at|=|:)?\s*(\d{2,3})\b|\b(?:to|at)\s+(\d{2,3})\s*(?:bpm)?\b(?=\s*$|\s+(?:in|and|for|bpm))/.exec(text);
  const byNumber = named ? Number(named[1] ?? named[2] ?? named[3]) : null;
  const isRelative = /\b(?:by|up|down|faster|slower|more|less)\b/.test(text);
  if (byNumber !== null && Number.isFinite(byNumber) && byNumber >= MIN_BPM && !(isRelative && /\bby\b/.test(text))) {
    const bpm = clampBpm(byNumber);
    return { bpm, summary: `${bpm} BPM` };
  }
  if (/\bdouble[- ]?time\b/.test(text)) return { bpm: clampBpm(currentBpm * 2), summary: 'double time' };
  if (/\bhalf[- ]?time\b/.test(text)) return { bpm: clampBpm(currentBpm / 2), summary: 'half time' };
  const wantsFaster = /\bfaster\b|\bspeed(?:ed)?(?: it)? up\b|\bquicker\b|\bup(?:beat)? the tempo\b|\braise the tempo\b|\bincrease the tempo\b/.test(text);
  const wantsSlower = /\bslower\b|\bslow(?:ed)?(?: it)? down\b|\bmore relaxed tempo\b|\blower the tempo\b|\bdecrease the tempo\b|\breduce the tempo\b/.test(text);
  if (!wantsFaster && !wantsSlower) return null;
  const byBpm = /\bby\s+(\d{1,2})\s*(?:bpm)?\b/.exec(text);
  const share = byAmount(amount, [0.04, 0.08, 0.16]);
  const change = byBpm ? Number(byBpm[1]) : Math.max(3, Math.round(currentBpm * share));
  const bpm = clampBpm(currentBpm + (wantsFaster ? change : -change));
  return { bpm, summary: `${bpm} BPM` };
}

/** A key change the words ask for: a new key, or a move by some semitones. */
export type KeyChange =
  | { kind: 'key'; root: number; minor: boolean | null }
  | { kind: 'shift'; semitones: number };

const LETTERS: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** The intervals a "up a fifth" names, in semitones. */
const INTERVALS: Readonly<Record<string, number>> = {
  semitone: 1,
  'half step': 1,
  'half-step': 1,
  halfstep: 1,
  tone: 2,
  'whole step': 2,
  'whole-step': 2,
  'minor third': 3,
  'major third': 4,
  third: 4,
  fourth: 5,
  fifth: 7,
  octave: 12,
};

/** The pitch class of a note name as the musician writes it ("f#", "bb", "c sharp"). */
function pitchClassOf(letter: string, accidental: string | undefined): number {
  let root = LETTERS[letter] ?? 0;
  if (accidental === '#' || accidental === 'sharp') root += 1;
  if (accidental === 'b' || accidental === 'flat') root -= 1;
  return ((root % 12) + 12) % 12;
}

/** The key change the words ask for ("to f minor", "up 2 semitones", "down a tone"), or null. */
export function keyChangeIn(text: string): KeyChange | null {
  const absolute =
    /\b(?:to|in|into|key of|key|into the key of)\s+([a-g])\s*(#|b|sharp|flat)?\s*(major|minor|maj|min|m)\b/.exec(text) ??
    /\bkey\s+(?:of\s+|to\s+)?([a-g])\s*(#|b|sharp|flat)?\b/.exec(text);
  if (absolute) {
    const mode = absolute[3];
    const minor = mode === undefined ? null : mode.startsWith('maj') ? false : true;
    return { kind: 'key', root: pitchClassOf(absolute[1] as string, absolute[2]), minor };
  }
  const direction = /\bdown\b|\blower\b|\bdrop\b|\bbelow\b/.test(text) ? -1 : 1;
  const counted = /(\d{1,2})\s*(?:semitones?|half[- ]?steps?|st\b)/.exec(text);
  if (counted) return { kind: 'shift', semitones: direction * Number(counted[1]) };
  const interval = /\b(?:up|down|higher|lower)\s+(?:a|an|one)?\s*(minor third|major third|semitone|half[- ]?step|whole[- ]?step|tone|third|fourth|fifth|octave)\b/.exec(text);
  if (interval) {
    const semitones = INTERVALS[(interval[1] as string).replace('half step', 'half step')] ?? 0;
    const sign = /\bdown\b|\blower\b/.test(interval[0]) ? -1 : 1;
    return { kind: 'shift', semitones: sign * semitones };
  }
  return null;
}
