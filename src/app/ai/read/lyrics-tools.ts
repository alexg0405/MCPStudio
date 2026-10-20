/** The read tool for the lyrics lane: the lines as text with their bar, and (when asked) every word's place. */
import { lyricLines } from '@core/query/lyrics';
import * as S from '../schema/parts';
import { barCount, barNumberAt, barRange, BAR_RANGE, projectOf, tool } from './tool';

/** Most words get_lyrics lists when asked for them (the lines carry the text of the rest). */
const MAX_WORDS = 400;

export const getLyrics = tool(
  'get_lyrics',
  'The lyrics on the lyrics lane: one entry per lyric line with its 1-based bar, length in bars and text (syllables rejoined into words), in time order; with words: true also each word or syllable with its bar (fractions allowed) and bars, for lining words up with notes. from_bar / to_bar limit it to those bars. The set_lyrics action writes them.',
  {
    ...BAR_RANGE,
    words: S.bool('Also list every word or syllable with its place (up to 400).'),
  },
  (services, args) => {
    const project = projectOf(services);
    const { from, to } = barRange(project, args);
    const lines = lyricLines(project).filter((line) => line.start < to && line.end > from);
    const wantWords = args.words === true;
    let listed = 0;
    const result = lines.map((line) => ({
      line: line.index + 1,
      bar: barNumberAt(project, line.start),
      bars: barCount(project, line.end - line.start),
      text: line.text,
      ...(wantWords && listed < MAX_WORDS
        ? {
            words: line.words.map((word) => {
              listed++;
              return {
                text: word.continues ? `${word.text}-` : word.text,
                bar: barNumberAt(project, word.tick),
                bars: barCount(project, word.length),
              };
            }),
          }
        : {}),
    }));
    return { lines: result, total_lines: lyricLines(project).length };
  },
);
