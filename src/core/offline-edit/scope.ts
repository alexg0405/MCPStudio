/**
 * Which part of the song a request is about, read from the words: "bars 9–16", "the first 8 bars", "in the chorus", "verse 2",
 * "the last chorus", "into the drop", "at the end". The part the musician picked in the playlist (the focus) wins over words.
 */
import { describeRange, type SongFacts } from './song-facts';
import type { BarRange, EditInput, Scope, SectionInfo } from './types';

/** A scope read from the words, the words left over, and a section the song does not have. */
export interface ReadScope {
  scope: Scope;
  /** The words with the part named in them taken out, so the rest of the reading does not trip over "9" or "chorus". */
  rest: string;
  /** The section word the musician used when the song has no such section ("the bridge" in a song without one). */
  missing: string | null;
}

const SECTION_WORD =
  '(pre-?chorus|choruses|chorus|hooks?|drops?|verses?|intro|outro|bridges?|breakdowns?|breaks?|build-?ups?|builds?|interlude)';
const ORDINAL = '(first|second|third|fourth|last|final|\\d+(?:st|nd|rd|th))';
/** Words that put a part after them ("in the chorus", "make the verse…", "into the drop"). */
const PREPOSITION =
  '(?:in|during|for|of|on|at|over|across|inside|within|throughout|to|into|before|after|from|make|let|have|turn|leading into|lead into|going into|heading into|up to|ahead of|until|under|around|through)';
const SECTION_PHRASE = new RegExp(
  `(?:\\b${PREPOSITION}\\s+(?:all(?: of)?\\s+|every\\s+|each\\s+)?(?:the\\s+)?|\\b(?:all(?: of)?\\s+|every\\s+|each\\s+)(?:the\\s+)?|\\bthe\\s+)(?:${ORDINAL}\\s+)?${SECTION_WORD}(?:\\s+(\\d+))?\\b`,
);

const ORDINALS: Readonly<Record<string, number>> = { first: 0, second: 1, third: 2, fourth: 3 };

/** The part of the song the words point at, such as "into" or "at the end" (null when they do not say). */
function anchorIn(text: string): Scope['anchor'] {
  if (/\b(?:into|leading into|lead into|going into|heading into|lead-in to)\b/.test(text)) return 'into';
  if (/\b(?:before|ahead of|up to)\b/.test(text)) return 'before';
  if (/\bafter\b/.test(text)) return 'after';
  if (/\b(?:at|toward|towards|in) the end\b|\bend of\b|\bat the very end\b|\bto finish\b/.test(text)) return 'end';
  if (/\b(?:at|in) the (?:start|beginning)\b|\b(?:start|beginning) of\b/.test(text)) return 'start';
  return null;
}

/** The role word of a section word the way section names say it: plurals and spellings folded. */
function foldedWord(word: string): string {
  const plain = word.replace(/-/g, '');
  if (plain.startsWith('prechorus')) return 'pre';
  if (plain.startsWith('chorus')) return 'chorus';
  if (plain.startsWith('hook')) return 'hook';
  if (plain.startsWith('drop')) return 'drop';
  if (plain.startsWith('verse')) return 'verse';
  if (plain.startsWith('bridge')) return 'bridge';
  if (plain.startsWith('breakdown') || plain.startsWith('break')) return 'break';
  if (plain.startsWith('buildup') || plain.startsWith('build')) return 'build';
  return plain;
}

/** The loudest parts of a song are called chorus, hook or drop; a song that has only one of these words means them all. */
const PEAK_WORDS: ReadonlySet<string> = new Set(['chorus', 'hook', 'drop']);

/** The number a section's name ends with ("Verse 2" is 2), or null. */
function numberOfName(name: string): number | null {
  const found = /(\d+)\s*$/.exec(name);
  return found ? Number(found[1]) : null;
}

/** The sections a section word, a number and an ordinal point at. */
function matchSections(
  word: string,
  ordinal: string | undefined,
  number: string | undefined,
  facts: SongFacts,
): SectionInfo[] {
  const folded = foldedWord(word);
  let found = facts.sections.filter((section) => section.role === folded || section.name.toLowerCase().replace(/-/g, '').includes(folded));
  if (found.length === 0 && PEAK_WORDS.has(folded)) found = facts.sections.filter((section) => PEAK_WORDS.has(section.role ?? ''));
  if (number !== undefined) {
    const wanted = Number(number);
    found = found.filter((section) => (numberOfName(section.name) ?? 1) === wanted);
  }
  if (ordinal !== undefined && found.length > 0) {
    if (ordinal === 'last' || ordinal === 'final') return [found[found.length - 1] as SectionInfo];
    const index = ORDINALS[ordinal] ?? Number.parseInt(ordinal, 10) - 1;
    const picked = found[index];
    return picked ? [picked] : [];
  }
  return found;
}

/** "the Hook (bars 17–24)", "the Verse (bars 5–12) and the Verse 2 (bars 25–32)". */
function labelFor(ranges: readonly BarRange[], facts: SongFacts): string {
  const parts = ranges.map((range) => {
    const section = facts.sections.find((x) => x.range.fromBar === range.fromBar && x.range.toBar === range.toBar);
    return section ? `the ${section.name} (${describeRange(range)})` : describeRange(range);
  });
  return parts.length <= 3 ? parts.join(' and ') : `${parts.length} parts of the song`;
}

/** A range cut to the song and put the right way round (null when nothing of it is in the song). */
function clampRange(range: BarRange, totalBars: number): BarRange | null {
  const fromBar = Math.max(1, Math.min(range.fromBar, range.toBar));
  const toBar = Math.min(totalBars, Math.max(range.fromBar, range.toBar));
  return fromBar > totalBars || toBar < fromBar ? null : { fromBar, toBar };
}

/** Bar ranges named in the words, and the words without them. */
function barsIn(text: string, totalBars: number): { ranges: BarRange[]; rest: string } | null {
  const between = /\b(?:from |in |on |for |over |during |across |into |before |after )?bars? (\d+)\s*(?:-|to|through|thru|until|till|and)\s*(?:bar )?(\d+)\b/.exec(text);
  if (between) {
    const range = clampRange({ fromBar: Number(between[1]), toBar: Number(between[2]) }, totalBars);
    return range ? { ranges: [range], rest: text.replace(between[0], ' ') } : null;
  }
  const first = /\b(?:in |for |over |during )?the first (\d+) bars?\b/.exec(text);
  if (first) {
    const range = clampRange({ fromBar: 1, toBar: Number(first[1]) }, totalBars);
    return range ? { ranges: [range], rest: text.replace(first[0], ' ') } : null;
  }
  const last = /\b(?:in |for |over |during )?the last (\d+) bars?\b/.exec(text);
  if (last) {
    const range = clampRange({ fromBar: totalBars - Number(last[1]) + 1, toBar: totalBars }, totalBars);
    return range ? { ranges: [range], rest: text.replace(last[0], ' ') } : null;
  }
  const single = /\b(?:at |in |on |into |before |after |from |around )?bar (\d+)\b/.exec(text);
  if (single) {
    const range = clampRange({ fromBar: Number(single[1]), toBar: Number(single[1]) }, totalBars);
    return range ? { ranges: [range], rest: text.replace(single[0], ' ') } : null;
  }
  return null;
}

/** The scope when no part is named: the whole song. */
function wholeSong(facts: SongFacts, anchor: Scope['anchor']): Scope {
  const ranges = facts.totalBars > 0 ? [{ fromBar: 1, toBar: facts.totalBars }] : [];
  return { ranges, isNamed: false, isFocus: false, label: 'the whole song', anchor };
}

/** The part of the song a clause is about. */
export function readScope(text: string, facts: SongFacts, focus: EditInput['focus']): ReadScope {
  const anchor = anchorIn(text);
  if (focus) {
    return {
      scope: { ranges: [focus.range], isNamed: true, isFocus: true, label: focus.label, anchor },
      rest: text,
      missing: null,
    };
  }
  const bars = barsIn(text, facts.totalBars);
  if (bars) {
    const label = labelFor(bars.ranges, facts);
    return { scope: { ranges: bars.ranges, isNamed: true, isFocus: false, label, anchor }, rest: bars.rest.replace(/\s+/g, ' ').trim(), missing: null };
  }
  const phrase = SECTION_PHRASE.exec(text);
  // "the whole song", "throughout" and "everywhere" are the same as naming nothing.
  if (!phrase) return { scope: wholeSong(facts, anchor), rest: text, missing: null };
  const word = phrase[2] as string;
  const matches = matchSections(word, phrase[1], phrase[3], facts);
  const rest = text.replace(phrase[0], ' ').replace(/\s+/g, ' ').trim();
  if (matches.length === 0) return { scope: wholeSong(facts, anchor), rest, missing: foldedWord(word) };
  const ranges = matches.map((section) => section.range);
  return { scope: { ranges, isNamed: true, isFocus: false, label: labelFor(ranges, facts), anchor }, rest, missing: null };
}
