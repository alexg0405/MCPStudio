/**
 * Lyrics out as text: plain lines, and LRC (the timed lyrics format music players show as karaoke). The times come
 * through the tempo map, so tempo changes are respected.
 */
import type { LyricWord } from '../model/types';
import type { TempoMap } from '../time/ppq';
import { groupLines, lineText } from './lines';

/** Plain text: one line per lyric line, syllables rejoined into words. */
export function lyricsToText(sorted: readonly LyricWord[]): string {
  return groupLines(sorted)
    .map((line) => line.text)
    .join('\n');
}

/** Seconds as LRC's `mm:ss.xx` (centiseconds; minutes may pass 99). */
export function lrcTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(centiseconds / 6000);
  const rest = centiseconds - minutes * 6000;
  const wholeSeconds = Math.floor(rest / 100);
  const hundredths = rest - wholeSeconds * 100;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/**
 * The lyrics as MIDI lyric events (what a MIDI karaoke player reads): one per syllable at its tick, "/" before the first
 * syllable of every line but the first, and a space after the last syllable of a word.
 */
export function lyricsToMidiEvents(sorted: readonly LyricWord[]): Array<{ tick: number; text: string }> {
  const events: Array<{ tick: number; text: string }> = [];
  for (const line of groupLines(sorted)) {
    for (const [i, word] of line.words.entries()) {
      const lineBreak = i === 0 && line.index > 0 ? '/' : '';
      events.push({ tick: word.tick, text: `${lineBreak}${word.text}${word.continues ? '' : ' '}` });
    }
  }
  return events;
}

/** What `lyricsToLrc` can add. */
export interface LrcOptions {
  /** A title tag (`[ti:…]`). */
  title?: string;
  /** Also a time before every word or syllable (enhanced LRC: `<mm:ss.xx>`), so players can light words one by one. */
  perWord?: boolean;
}

/** A line as enhanced LRC: each word or syllable has its own time in angle brackets. */
function enhancedText(words: readonly LyricWord[], tempo: TempoMap): string {
  let text = '';
  for (const [i, word] of words.entries()) {
    text += `<${lrcTime(tempo.tickToSeconds(word.tick))}>${word.text}`;
    if (i < words.length - 1 && !word.continues) text += ' ';
  }
  return text;
}

/** The lyrics as LRC: `[mm:ss.xx]line`, one per lyric line at the time its first word starts. */
export function lyricsToLrc(sorted: readonly LyricWord[], tempo: TempoMap, options: LrcOptions = {}): string {
  const out: string[] = [];
  if (options.title) out.push(`[ti:${options.title.replace(/[\r\n\]]/g, ' ')}]`);
  for (const line of groupLines(sorted)) {
    const stamp = `[${lrcTime(tempo.tickToSeconds(line.start))}]`;
    out.push(`${stamp}${options.perWord ? enhancedText(line.words, tempo) : lineText(line.words)}`);
  }
  return out.join('\n');
}
