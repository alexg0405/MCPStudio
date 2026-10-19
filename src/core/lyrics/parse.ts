/**
 * Reading pasted lyrics: lines, then words, then syllables. "beau-ti-ful" (and "beau- ti- ful", "beau - ti - ful")
 * is three syllables that read back as one word; every other space-separated token is a word of one syllable.
 * Pure, tested in Node.
 */

/** The longest text one syllable keeps (characters). */
export const MAX_SYLLABLE_CHARS = 80;
/** The most syllables one paste keeps (a long song has a few hundred). */
export const MAX_SYLLABLES = 4096;

/** One sung syllable (or a whole one-syllable word). */
export interface Syllable {
  /** The text without hyphens. */
  text: string;
  /** True when the word goes on in the next syllable. */
  continues: boolean;
}

/** What `parseLyrics` found: the lines (each a list of syllables) and whether the text was cut at `MAX_SYLLABLES`. */
export interface ParsedLyrics {
  lines: Syllable[][];
  /** How many syllables there are in all. */
  count: number;
  isTruncated: boolean;
}

/** A token made only of dashes ("-", "–", "—"): a join between syllables written with spaces around it. */
const ONLY_DASHES = /^[-–—]+$/;
/** The dashes that split a token into syllables (a hyphen, en dash or em dash between two letters). */
const DASHES = /[-–—]+/;

/** The syllables of one space-separated token, with the dash at either end turned into `joinsBefore` / `continues`. */
function syllablesOfToken(token: string): { parts: string[]; joinsBefore: boolean; continues: boolean } {
  const joinsBefore = /^[-–—]/.test(token);
  const continues = /[-–—]$/.test(token);
  const parts = token.split(DASHES).filter((part) => part.length > 0);
  return { parts, joinsBefore, continues };
}

/**
 * The syllables of one line (a dash at the start of a token, or a token of dashes, joins it to the syllable before). Stops
 * at `budget` syllables and says whether it had to.
 */
function syllablesOfLine(line: string, budget: number): { syllables: Syllable[]; isCut: boolean } {
  const syllables: Syllable[] = [];
  let isCut = false;
  for (const token of line.split(/\s+/)) {
    if (token === '') continue;
    const last = syllables[syllables.length - 1];
    if (ONLY_DASHES.test(token)) {
      if (last) last.continues = true;
      continue;
    }
    const { parts, joinsBefore, continues } = syllablesOfToken(token);
    if (joinsBefore && last) last.continues = true;
    for (const [index, part] of parts.entries()) {
      if (syllables.length >= budget) {
        isCut = true;
        break;
      }
      const isLastPart = index === parts.length - 1;
      syllables.push({ text: part.slice(0, MAX_SYLLABLE_CHARS), continues: !isLastPart || continues });
    }
  }
  // A word never runs on past the end of its line.
  const end = syllables[syllables.length - 1];
  if (end) end.continues = false;
  return { syllables, isCut };
}

/** Splits text into lines of syllables (blank lines are skipped). */
export function parseLyrics(text: string): ParsedLyrics {
  const lines: Syllable[][] = [];
  let count = 0;
  let isTruncated = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const { syllables, isCut } = syllablesOfLine(line, MAX_SYLLABLES - count);
    if (isCut) isTruncated = true;
    if (syllables.length === 0) continue;
    lines.push(syllables);
    count += syllables.length;
  }
  return { lines, count, isTruncated };
}
